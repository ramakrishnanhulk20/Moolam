import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { InvalidToken, bearerToken, verifyPrivyToken, type PrivyIdentity, type PrivyKeys } from "../auth/privy.js";
import { SignerUnavailable, ensureSigner } from "../c2pa.js";
import { passportExists } from "../edit/registry.js";
import { MAX_UPLOAD_BYTES, env } from "../env.js";
import { ImageTooLarge, readImageHeader, type Hex } from "../fingerprint.js";
import { Busy } from "../generate/gate.js";
import { gatewayUrl, pinFile, pinJson } from "../ipfs/pinata.js";
import {
  CAPTURED_DESCRIPTION,
  CAPTURE_SOURCE_TYPE,
  FINGERPRINT_VERSION,
  fileSlug,
  passportMetadata,
} from "../metadata.js";
import { prepareOrFallback } from "../prepare.js";
import { readClient } from "../reputation/registry.js";
import { BadRequest, statusOf } from "./shared.js";

/** What the C2PA manifest records as the tool that made the claim. */
const CLAIM_GENERATOR = "moolam-studio/0.1.0";

/**
 * How many images one signed-in creator may prepare an hour.
 *
 * Every prepare spends four pins on Ram's Pinata account and about a second of CPU, so the cap is
 * what stops one account draining the plan. It is counted on the verified Privy user id, which a
 * caller cannot choose, and falls back to the socket address for a caller with no valid token.
 */
const PREPARES_PER_HOUR = 20;

/** A Captured passport carries no generator agent, and the studio only takes human uploads. */
const HUMAN_KIND = 1;
const NO_AGENT = 0n;
const ZERO_BYTES32 = `0x${"00".repeat(32)}` as Hex;

const titleSchema = z.string().trim().min(1).max(120);

/** One verification per request, shared by the rate-limit key and the handler. */
const identities = new WeakMap<FastifyRequest, Promise<PrivyIdentity | undefined>>();

interface Upload {
  bytes: Buffer;
  title: string;
}

/**
 * POST /prepare: everything a signed-in creator needs before they sign a passport.
 *
 * It takes their image, turns it the right way up, embeds the Moolam C2PA manifest, fingerprints
 * the signed bytes, builds the thumbnail the Chainlink verifier can fetch, pins the image, the
 * thumbnail, the manifest and the metadata to IPFS, and hands back the passport fields. The
 * browser adds its own wallet address and deadline, reads hashPassport from the registry, signs
 * that with the passkey and sends the transaction itself, so this service never holds a key that
 * can write to the chain.
 *
 * The image bytes never come back in the answer: the caller already has them, and the response
 * has to stay small enough to sit in a browser's memory next to the upload. The decode, the
 * manifest and the thumbnail run behind the same concurrency gate as matching, so a burst of
 * uploads queues instead of decoding all at once.
 *
 * Answers 401 for a missing or foreign token, 400 for a bad title or kind, 413 over the size or
 * pixel limit, 415 when the file is not an image, 409 `already-registered` when the registry
 * already holds this exact picture, 429 past the per-user limit, and 502 when Pinata refuses a
 * pin. The route is not mounted at all on a host that cannot sign a manifest.
 */
export async function prepareRoutes(app: FastifyInstance, options: { keys?: PrivyKeys } = {}): Promise<void> {
  // A host with no signing identity would otherwise answer 200 with an unsigned picture for every
  // upload, so it fails to mount instead and says why in the boot log.
  await ensureSigner();

  const chain = readClient();
  const registry = env.MOOLAM_REGISTRY_ADDRESS as Hex;

  app.post(
    "/prepare",
    {
      config: {
        rateLimit: {
          max: PREPARES_PER_HOUR,
          timeWindow: "1 hour",
          keyGenerator: async (request: FastifyRequest) => {
            const identity = await identify(request, options.keys);
            return identity === undefined ? `ip:${request.ip}` : `user:${identity.userId}`;
          },
          onExceeded: (request: FastifyRequest) => {
            request.log.warn({ ip: request.ip, url: request.url }, "rejected: prepare limit exceeded");
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const identity = await identify(request, options.keys);
      if (identity === undefined) {
        request.log.warn({ ip: request.ip, url: request.url }, "rejected: /prepare unauthorized");
        return reply.code(401).send({ error: "unauthorized" });
      }

      let upload: Upload;
      try {
        upload = await readStudioUpload(request);
      } catch (error) {
        const status = statusOf(error);
        const reason = error instanceof Error ? error.message : String(error);
        request.log.warn({ ip: request.ip, url: request.url, status, reason }, "rejected: /prepare");
        return reply.code(status).send({ error: reason });
      }

      try {
        await readImageHeader(upload.bytes);
      } catch (error) {
        const tooBig = error instanceof ImageTooLarge;
        const reason = error instanceof Error ? error.message : String(error);
        request.log.warn({ ip: request.ip, url: request.url, reason }, "rejected: /prepare image");
        return reply.code(tooBig ? 413 : 415).send({ error: tooBig ? reason : "not-an-image" });
      }

      let studio;
      try {
        studio = await app.verifier.runPrepare(() =>
          prepareOrFallback(upload.bytes, {
            title: upload.title,
            claimGenerator: CLAIM_GENERATOR,
            action: "c2pa.created",
            digitalSourceType: CAPTURE_SOURCE_TYPE,
          }),
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (error instanceof Busy) {
          request.log.warn({ url: request.url, reason }, "rejected: /prepare busy");
          return reply.code(503).send({ error: "busy" });
        }
        if (error instanceof SignerUnavailable) {
          request.log.error({ url: request.url, reason }, "rejected: /prepare the signer is down");
          return reply.code(502).send({ error: "sign-failed" });
        }
        // readImageHeader passes on a file whose header is intact and whose pixels are not, so a
        // truncated upload only fails here. That is the caller's file, not this service breaking.
        request.log.warn({ url: request.url, reason }, "rejected: /prepare undecodable image");
        return reply.code(415).send({ error: "not-an-image", reason: "the file could not be decoded" });
      }
      if (!studio.embedded) {
        request.log.warn({ url: request.url, reason: studio.detail }, "prepare: manifest not embedded");
      }

      const passportId = studio.print.sha256 as Hex;
      if (await alreadyRegistered(chain, registry, passportId, request)) {
        request.log.warn({ url: request.url, user: identity.userId, passportId }, "rejected: /prepare duplicate");
        return reply.code(409).send({ error: "already-registered", passportId });
      }

      const slug = fileSlug(upload.title, studio.print.sha256);
      try {
        const image = await pinFile(studio.bytes, `${slug}.jpg`, "image/jpeg");
        const thumbnail = await pinFile(studio.thumbnail, `${slug}-thumb.jpg`, "image/jpeg");
        const manifest =
          studio.manifestDoc === undefined ? undefined : await pinJson(studio.manifestDoc, `${slug}-c2pa.json`);

        const metadata = passportMetadata({
          title: upload.title,
          description: CAPTURED_DESCRIPTION,
          image: image.uri,
          thumbnail: thumbnail.uri,
          manifest: manifest?.uri,
          agentId: NO_AGENT,
          fingerprint: studio.print,
        });
        const pinnedMetadata = await pinJson(metadata, `${slug}.json`);

        return reply.send({
          passport: {
            exactHash: studio.print.sha256,
            parentId: ZERO_BYTES32,
            generatorAgentId: NO_AGENT.toString(),
            phash: studio.print.phash.toString(),
            blockhash256: studio.print.blockhash,
            manifestHash: studio.manifestHash,
            kind: HUMAN_KIND,
            fingerprintVersion: FINGERPRINT_VERSION,
            metadataURI: pinnedMetadata.uri,
          },
          image: {
            cid: image.cid,
            uri: image.uri,
            gatewayUrl: gatewayUrl(image.uri),
            bytes: studio.bytes.length,
            width: studio.print.width,
            height: studio.print.height,
          },
          thumbnail: { cid: thumbnail.cid, uri: thumbnail.uri, gatewayUrl: gatewayUrl(thumbnail.uri) },
          metadata: { cid: pinnedMetadata.cid, uri: pinnedMetadata.uri },
          manifest: studio.embedded ? { embedded: true } : { embedded: false, reason: studio.reason },
          preparedBy: identity.userId,
        });
      } catch (error) {
        // pinFile's message carries Pinata's status and its answer, and never the token.
        const reason = error instanceof Error ? error.message : String(error);
        request.log.error({ ip: request.ip, url: request.url, reason }, "rejected: /prepare pin failed");
        return reply.code(502).send({ error: "pin-failed" });
      }
    },
  );
}

/**
 * Verifies the caller's Privy access token once per request.
 *
 * The rate limiter needs the user id before the handler runs, and the handler needs it again, so
 * the promise is remembered against the request rather than the token being checked twice.
 * Anything wrong with the token, including a JWKS that cannot be fetched, comes back as undefined
 * and becomes a 401.
 */
async function identify(request: FastifyRequest, keys?: PrivyKeys): Promise<PrivyIdentity | undefined> {
  const known = identities.get(request);
  if (known !== undefined) {
    return await known;
  }

  const pending = (async () => {
    const token = bearerToken(request.headers.authorization);
    if (token === undefined) {
      return undefined;
    }
    try {
      return await verifyPrivyToken(token, keys);
    } catch (error) {
      if (error instanceof InvalidToken) {
        request.log.warn({ ip: request.ip, reason: error.message }, "rejected: bad Privy token");
        return undefined;
      }
      throw error;
    }
  })();

  identities.set(request, pending);
  return await pending;
}

/**
 * Reads the image and the two text fields out of the multipart body, in whatever order the
 * browser sent them.
 *
 * Throws BadRequest: 413 over the byte limit, 400 for a missing file, a file part under another
 * name, a title outside 1 to 120 characters, or any kind other than "human".
 */
async function readStudioUpload(request: FastifyRequest): Promise<Upload> {
  if (!request.isMultipart()) {
    throw new BadRequest('send the image in a multipart field named "file"');
  }

  let bytes: Buffer | undefined;
  const fields = new Map<string, string>();

  try {
    for await (const part of request.parts({ limits: { fileSize: MAX_UPLOAD_BYTES } })) {
      if (part.type === "file") {
        if (part.fieldname !== "file") {
          throw new BadRequest(`expected a multipart field named "file", got "${part.fieldname}"`);
        }
        bytes = await part.toBuffer();
      } else if (typeof part.value === "string") {
        fields.set(part.fieldname, part.value);
      }
    }
  } catch (error) {
    if ((error as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
      throw new BadRequest(`the image is larger than the ${MAX_UPLOAD_BYTES} byte limit`, 413);
    }
    throw error;
  }

  if (bytes === undefined || bytes.length === 0) {
    throw new BadRequest('send the image in a multipart field named "file"');
  }

  const title = titleSchema.safeParse(fields.get("title"));
  if (!title.success) {
    throw new BadRequest('send a "title" field of 1 to 120 characters');
  }
  if (fields.get("kind") !== "human") {
    throw new BadRequest('the only kind the studio takes today is "human"');
  }

  return { bytes, title: title.data };
}

/**
 * Whether the registry already holds this exact picture.
 *
 * Asked before anything is pinned, so the same file uploaded twice gets a plain answer instead of
 * four fresh pins and a transaction the registry would refuse anyway. A chain this host cannot
 * reach does not stop a prepare: the registry makes the same check when the browser sends the
 * passport, so a missed check costs pins and never correctness.
 */
async function alreadyRegistered(
  chain: ReturnType<typeof readClient>,
  registry: Hex,
  passportId: Hex,
  request: FastifyRequest,
): Promise<boolean> {
  try {
    return await passportExists(chain, registry, passportId);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    request.log.warn({ url: request.url, reason }, "prepare: the duplicate check could not reach the chain");
    return false;
  }
}
