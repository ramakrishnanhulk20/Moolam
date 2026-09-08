import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { InvalidToken, bearerToken, verifyPrivyToken, type PrivyIdentity, type PrivyKeys } from "../auth/privy.js";
import { MAX_UPLOAD_BYTES } from "../env.js";
import { ImageTooLarge, fingerprint, readImageHeader, type Fingerprint, type Hex } from "../fingerprint.js";
import { gatewayUrl, pinFile, pinJson } from "../ipfs/pinata.js";
import {
  CAPTURED_DESCRIPTION,
  CAPTURE_SOURCE_TYPE,
  FINGERPRINT_VERSION,
  fileSlug,
  manifestDocument,
  passportMetadata,
} from "../metadata.js";
import { makeThumbnail, prepareImage, uprightImage } from "../prepare.js";
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

interface StudioImage {
  /** The bytes that get pinned, and whose sha256 becomes the passport id. */
  bytes: Buffer;
  thumbnail: Buffer;
  print: Fingerprint;
  manifestHash: Hex;
  manifestDoc?: unknown;
  embedded: boolean;
  reason?: string;
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
 * pixel limit, 415 when the file is not an image, 429 past the per-user limit, and 502 when
 * Pinata refuses a pin.
 */
export async function prepareRoutes(app: FastifyInstance, options: { keys?: PrivyKeys } = {}): Promise<void> {
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

      const studio = await app.verifier.runPrepare(() => studioImage(upload.bytes, upload.title));
      if (!studio.embedded) {
        request.log.warn({ url: request.url, reason: studio.reason }, "prepare: manifest not embedded");
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
 * Prepares the picture for pinning, with the manifest when C2PA will sign it and without when it
 * will not.
 *
 * A file the signer refuses, an unusual container or a missing certificate should not cost the
 * creator their upload: the fingerprint and the on-chain record work with no manifest at all,
 * they just lose the provenance that travels inside the file. The answer says which happened.
 */
async function studioImage(bytes: Buffer, title: string): Promise<StudioImage> {
  try {
    const prepared = await prepareImage(bytes, {
      title,
      claimGenerator: CLAIM_GENERATOR,
      action: "c2pa.created",
      digitalSourceType: CAPTURE_SOURCE_TYPE,
    });
    return {
      bytes: prepared.original,
      thumbnail: prepared.thumbnail,
      print: prepared.fingerprint,
      manifestHash: prepared.manifestHash,
      manifestDoc: manifestDocument(prepared),
      embedded: true,
    };
  } catch (error) {
    const upright = await uprightImage(bytes);
    return {
      bytes: upright,
      thumbnail: await makeThumbnail(upright),
      print: await fingerprint(upright),
      manifestHash: ZERO_BYTES32,
      embedded: false,
      reason: (error instanceof Error ? error.message : String(error)).slice(0, 200),
    };
  }
}
