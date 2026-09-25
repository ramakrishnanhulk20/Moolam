import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { InvalidToken, bearerToken, verifyPrivyToken, type PrivyIdentity, type PrivyKeys } from "../auth/privy.js";
import { SignerUnavailable, ensureSigner } from "../c2pa.js";
import { trainingSchema, trainingStatement, type TrainingConsent } from "../consent.js";
import { MAX_UPLOAD_BYTES, env } from "../env.js";
import { ImageTooLarge, readImageHeader, type Hex } from "../fingerprint.js";
import { Busy } from "../generate/gate.js";
import { gatewayUrl, pinFile, pinJson } from "../ipfs/pinata.js";
import { takeToday } from "../limits/dayGate.js";
import {
  CAPTURED_DESCRIPTION,
  CAPTURE_SOURCE_TYPE,
  FINGERPRINT_VERSION,
  SEALED_CAPTURED_DESCRIPTION,
  SEALED_PRIVATE_CAPTURED_DESCRIPTION,
  fileSlug,
  passportMetadata,
} from "../metadata.js";
import {
  PRIVATE_RECHECK_THUMBNAIL_TOO_LARGE_REASON,
  THUMBNAIL_TOO_LARGE_REASON,
  ThumbnailTooLarge,
  makeThumbnail,
  prepareOrFallback,
  prepareSealed,
  type PreparedResult,
  type SealedResult,
} from "../prepare.js";
import type { PrivateFile } from "../ipfs/pinata.js";
import { readClient } from "../reputation/registry.js";
import {
  CHAIN_UNREACHABLE,
  PRIVATE_RECHECK_NEEDS_SEALED,
  SEALED_METADATA_REFUSED,
  dropPrivateCopy,
  keepPrivateCopy,
  registrationOf,
  sealedMetadata,
  signedFile,
  type SignedFile,
} from "../sealed.js";
import { BadRequest, statusOf } from "./shared.js";

/** What the C2PA manifest records as the tool that made the claim. */
const CLAIM_GENERATOR = "moolam-studio/0.1.0";

/**
 * How many images one signed-in creator may prepare an hour.
 *
 * Every prepare spends about a second of CPU and up to four pins on the operator's Pinata account, one of
 * them for a sealed registration, so the cap is what stops one account draining the plan. It is
 * counted on the verified Privy user id, which a caller cannot choose, and falls back to the
 * socket address for a caller with no valid token. A sealed registration is counted the same as
 * a public one: it is the same work and the same picture.
 */
const PREPARES_PER_HOUR = 20;

/** A Captured passport carries no generator agent, and the studio only takes human uploads. */
const HUMAN_KIND = 1;
const NO_AGENT = 0n;
const ZERO_BYTES32 = `0x${"00".repeat(32)}` as Hex;

const titleSchema = z.string().trim().min(1).max(120);

/**
 * How much text the optional training field may carry before it is refused unread.
 *
 * The whole statement is four short words and at most 256 bytes of note, so anything near this is
 * not a creator's answer. It is checked before the JSON is parsed, so a huge field costs nothing.
 */
const MAX_TRAINING_FIELD_BYTES = 1024;

/** One verification per request, shared by the rate-limit key and the handler. */
const identities = new WeakMap<FastifyRequest, Promise<PrivyIdentity | undefined>>();

interface Upload {
  bytes: Buffer;
  title: string;
  training?: TrainingConsent;
  /** True when the creator is registering the picture without publishing it. */
  sealed: boolean;
  /** True when a sealed creator also asked for a private Chainlink re-check. Never true unsealed. */
  privateRecheck: boolean;
}

/**
 * The only two words the sealed and privateRecheck fields may say.
 *
 * Anything else is refused rather than read as false. A typo that quietly meant "no" would
 * publish a picture the creator asked us to keep, and no later screen could take that back.
 */
const sealedSchema = z.enum(["true", "false"]);

/**
 * What a creator is told when the file this service is about to hand back does not hash to the
 * passport id, or carries no bytes at all.
 *
 * The check runs before the sealed document is pinned, so this answer can promise that nothing was
 * published. A commitment sitting on IPFS to a file the creator never received is the one outcome
 * a sealed registration must never leave behind, and it is the outcome a check after the pin
 * would leave. Which of the two ways it failed is this service's own fault to fix and stays in the
 * log, where it belongs.
 */
const SEALED_FILE_REFUSED = {
  error: "sealed-file-refused",
  reason:
    "this service could not hand back a sealed file matching the passport it was about to commit to, so nothing was pinned and nothing was registered. Please try again.",
} as const;

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
 * A creator may also say how AI may use the picture, in an optional `training` field. That
 * statement goes into the signed manifest and into the pinned metadata, so it travels with the
 * file and sits under the passkey signature rather than in a database of ours.
 *
 * With `sealed=true` the picture is registered without being published. Everything up to and
 * including the signing is the same, and then nothing of the picture is pinned or written down:
 * one small metadata document goes to IPFS, and the signed file itself comes back in the answer,
 * base64, as the only copy there will be. The passport id is the sha256 of that file, so the
 * chain still commits to the exact bytes. The answer is `no-store` and the creator's browser is
 * the only thing that ends up holding the picture.
 *
 * With `sealed=true` and `privateRecheck=true` one more thing is kept: a 512 px thumbnail of the
 * signed file on Pinata's private network, named after the passport id, so a later private
 * Chainlink run can re-check the picture without it ever being public. It is made only after the
 * chain has said the picture is not registered, it is uploaded before the document is pinned, and
 * it is deleted again if that pin fails. The public document gains `privateRecheck: true` and
 * nothing that names the private file.
 *
 * Answers 401 for a missing or foreign token, 400 for a bad title, kind, sealed or privateRecheck
 * flag or training statement, 400 `private-recheck-needs-sealed` for privateRecheck without
 * sealed, 413 over the size or pixel limit, 415 when the file is not an image, 422
 * `thumbnail-too-large` when a public or privately re-checked picture's thumbnail cannot fit the
 * Chainlink fetch budget, 409 `already-registered` when the registry already holds this exact
 * picture, 409 `private-copy-not-private` when Pinata did not keep the private copy private under
 * its name, 429 past the per-user limit or `global-limit` once GLOBAL_PREPARES_PER_DAY is spent
 * for everyone, 502 when Pinata refuses a pin, and 503 `chain-unreachable` when a private re-check
 * was asked for and the duplicate check could not reach the chain. The route is not mounted at all
 * on a host that cannot sign a manifest.
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

      // The day's ceiling for everyone, asked after the token and the hourly limit above have both
      // let this caller through and before the first thing that costs anything.
      const today = takeToday(app, request, reply, "prepares");
      if (!today.ok) {
        return today.refused;
      }

      // The ceiling bounds what the world may spend, so a slot that bought nothing goes back. The
      // first pin is where this request starts costing money: before it, every exit hands the slot
      // over to the next creator, and from it the slot stays taken however the request ends. An
      // hour of Pinata or the signer being down used to close the studio until midnight.
      let pinned = false;
      try {
        const settings = {
          title: upload.title,
          claimGenerator: CLAIM_GENERATOR,
          action: "c2pa.created" as const,
          digitalSourceType: CAPTURE_SOURCE_TYPE,
          training: upload.training,
        };

        let studio: SealedResult;
        // Filled only for a public registration, because only a public registration pins a
        // thumbnail and a manifest document. Its absence is what marks the sealed path below.
        let published: PreparedResult | undefined;
        // Filled only when a sealed creator asked for a private re-check. It is made by the same
        // makeThumbnail the public path uses, from the signed bytes, so the private run hashes
        // the same thumbnail a public run would (B14).
        let privateThumbnail: Buffer | undefined;
        try {
          if (upload.sealed) {
            const made = await app.verifier.runPrepare(async () => {
              const sealed = await prepareSealed(upload.bytes, settings);
              return { sealed, thumbnail: upload.privateRecheck ? await makeThumbnail(sealed.bytes) : undefined };
            });
            studio = made.sealed;
            privateThumbnail = made.thumbnail;
          } else {
            published = await app.verifier.runPrepare(() => prepareOrFallback(upload.bytes, settings));
            studio = published;
          }
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
          // A real picture with too much detail to fit the Chainlink fetch budget. Calling it
          // "not an image" sent creators looking for a fault in a file that has none. A plain
          // sealed prepare makes no thumbnail and never lands here; a privately re-checked one
          // does, and is told a plain sealed registration still works.
          if (error instanceof ThumbnailTooLarge) {
            request.log.warn({ url: request.url, reason }, "rejected: /prepare thumbnail too large");
            return reply.code(422).send({
              error: "thumbnail-too-large",
              limit: error.limit,
              reason: upload.sealed ? PRIVATE_RECHECK_THUMBNAIL_TOO_LARGE_REASON : THUMBNAIL_TOO_LARGE_REASON,
            });
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
        const registration = await registrationOf(chain, registry, passportId, request.log);
        if (registration === "registered") {
          request.log.warn({ url: request.url, user: identity.userId, passportId }, "rejected: /prepare duplicate");
          return reply.code(409).send({ error: "already-registered", passportId });
        }
        if (registration === "unreachable" && upload.privateRecheck) {
          request.log.warn(
            { url: request.url, user: identity.userId, passportId },
            "rejected: /prepare no private copy without a duplicate check",
          );
          return reply.code(503).send(CHAIN_UNREACHABLE);
        }

        const slug = fileSlug(upload.title, studio.print.sha256);
        const passport = (metadataURI: string): Record<string, unknown> => ({
          exactHash: studio.print.sha256,
          parentId: ZERO_BYTES32,
          generatorAgentId: NO_AGENT.toString(),
          phash: studio.print.phash.toString(),
          blockhash256: studio.print.blockhash,
          manifestHash: studio.manifestHash,
          kind: HUMAN_KIND,
          fingerprintVersion: FINGERPRINT_VERSION,
          metadataURI,
        });

        if (published === undefined) {
          let document;
          try {
            document = sealedMetadata({
              title: upload.title,
              description: upload.privateRecheck ? SEALED_PRIVATE_CAPTURED_DESCRIPTION : SEALED_CAPTURED_DESCRIPTION,
              passportId,
              fingerprint: studio.print,
              training: upload.training,
              privateRecheck: upload.privateRecheck,
            });
          } catch (error) {
            // The words that say which field did not fit are this service's own fault to fix, and
            // they stay here. The caller gets the fixed sentence and the knowledge that nothing
            // was pinned.
            const reason = error instanceof Error ? error.message : String(error);
            request.log.error({ url: request.url, reason }, "rejected: /prepare sealed record refused");
            return reply.code(500).send(SEALED_METADATA_REFUSED);
          }

          // The file is packed and checked against the id the chain will commit to before the
          // document is pinned, never after. A pinned commitment to a file the creator did not
          // receive cannot be taken back, and the file itself has no second copy to try again with.
          let file: SignedFile;
          try {
            file = signedFile(studio.bytes, `${slug}.jpg`, passportId);
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            request.log.error({ url: request.url, reason }, "rejected: /prepare sealed file refused");
            return reply.code(500).send(SEALED_FILE_REFUSED);
          }

          // The private copy goes up before the document, so a document that says privateRecheck
          // is never pinned for a copy that was refused.
          let privateCopy: PrivateFile | undefined;
          if (upload.privateRecheck) {
            if (privateThumbnail === undefined) {
              throw new Error("a private re-check was asked for and no thumbnail was made");
            }
            const copy = await keepPrivateCopy(privateThumbnail, passportId, request.log);
            if ("refused" in copy) {
              pinned = copy.landed;
              return reply.code(copy.refused.status).send(copy.refused.body);
            }
            privateCopy = copy.kept;
            pinned = true;
          }

          let pinnedMetadata;
          try {
            pinnedMetadata = await pinJson(document, `${slug}.json`);
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            request.log.error({ ip: request.ip, url: request.url, reason }, "rejected: /prepare sealed pin failed");
            if (privateCopy !== undefined) {
              await dropPrivateCopy(privateCopy, request.log);
            }
            return reply.code(502).send({ error: "pin-failed" });
          }
          pinned = true;

          // The base64 is never logged: nothing below writes a log line carrying it. The manifest
          // is reported in the same words as on the public path, because a creator whose file the
          // signer would not take has to hear it now: this is the only copy they get.
          return reply.send({
            passport: passport(pinnedMetadata.uri),
            metadata: { cid: pinnedMetadata.cid, uri: pinnedMetadata.uri },
            manifest: studio.embedded ? { embedded: true } : { embedded: false, reason: studio.reason },
            training: trainingStatement(upload.training),
            preparedBy: identity.userId,
            sealed: true,
            ...(privateCopy === undefined ? {} : { privateRecheck: true }),
            signedFile: file,
          });
        }

        // The picture, its thumbnail and the manifest document do not depend on each other, so
        // they go to Pinata at once rather than one after the next. Settled rather than raced,
        // because a failure still has to say what did land: a pin that succeeded is paid for and
        // is what decides whether this request keeps the day's slot.
        const [imagePin, thumbnailPin, manifestPin] = await Promise.allSettled([
          pinFile(published.bytes, `${slug}.jpg`, "image/jpeg"),
          pinFile(published.thumbnail, `${slug}-thumb.jpg`, "image/jpeg"),
          published.manifestDoc === undefined
            ? Promise.resolve(undefined)
            : pinJson(published.manifestDoc, `${slug}-c2pa.json`),
        ]);
        const attempted = [imagePin, thumbnailPin, manifestPin];
        pinned = attempted.some((one) => one.status === "fulfilled" && one.value !== undefined);

        if (imagePin.status === "rejected" || thumbnailPin.status === "rejected" || manifestPin.status === "rejected") {
          // pinFile's message carries Pinata's status and its answer, and never the token.
          request.log.error(
            {
              ip: request.ip,
              url: request.url,
              reason: attempted
                .filter((one) => one.status === "rejected")
                .map((one) => reasonOf(one.reason))
                .join("; "),
              landed: attempted.filter((one) => one.status === "fulfilled" && one.value !== undefined).length,
            },
            "rejected: /prepare pin failed",
          );
          return reply.code(502).send({ error: "pin-failed" });
        }

        const image = imagePin.value;
        const thumbnail = thumbnailPin.value;
        const metadata = passportMetadata({
          title: upload.title,
          description: CAPTURED_DESCRIPTION,
          image: image.uri,
          thumbnail: thumbnail.uri,
          manifest: manifestPin.value?.uri,
          agentId: NO_AGENT,
          fingerprint: published.print,
          training: upload.training,
        });

        let pinnedMetadata;
        try {
          pinnedMetadata = await pinJson(metadata, `${slug}.json`);
        } catch (error) {
          request.log.error(
            { ip: request.ip, url: request.url, reason: reasonOf(error) },
            "rejected: /prepare metadata pin failed",
          );
          return reply.code(502).send({ error: "pin-failed" });
        }

        return reply.send({
          passport: passport(pinnedMetadata.uri),
          image: {
            cid: image.cid,
            uri: image.uri,
            gatewayUrl: gatewayUrl(image.uri),
            bytes: published.bytes.length,
            width: published.print.width,
            height: published.print.height,
          },
          thumbnail: { cid: thumbnail.cid, uri: thumbnail.uri, gatewayUrl: gatewayUrl(thumbnail.uri) },
          metadata: { cid: pinnedMetadata.cid, uri: pinnedMetadata.uri },
          manifest: published.embedded ? { embedded: true } : { embedded: false, reason: published.reason },
          training: trainingStatement(upload.training),
          preparedBy: identity.userId,
        });
      } finally {
        if (!pinned) {
          today.slot.giveBack();
        }
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

  const sealed = readFlag(fields.get("sealed"), "sealed");
  const privateRecheck = readFlag(fields.get("privateRecheck"), "privateRecheck");
  if (privateRecheck && !sealed) {
    throw new BadRequest(PRIVATE_RECHECK_NEEDS_SEALED.error);
  }

  return {
    bytes,
    title: title.data,
    training: readTraining(fields.get("training")),
    sealed,
    privateRecheck,
  };
}

/**
 * Reads one of the two yes-or-no fields: sealed, and privateRecheck.
 *
 * Left out means no, which keeps every caller written before the field existed on exactly the
 * behaviour they had. Present and unreadable is refused: the two answers are not symmetric, and
 * guessing the safe one wrong publishes a file that cannot be unpublished, or keeps a private copy
 * the creator did not ask for.
 */
function readFlag(raw: string | undefined, field: "sealed" | "privateRecheck"): boolean {
  if (raw === undefined || raw.trim().length === 0) {
    return false;
  }
  const parsed = sealedSchema.safeParse(raw.trim());
  if (!parsed.success) {
    throw new BadRequest(`${field} must be "true" or "false"`);
  }
  return parsed.data === "true";
}

/**
 * Reads the optional training statement out of its multipart field.
 *
 * It travels as one JSON object rather than four flat fields so it is the same shape here, in the
 * /generate body, in the manifest and in the pinned document, and nobody has to reassemble it.
 *
 * Throws BadRequest when the field is too long, is not JSON, is not an object, or says something
 * the standard has no room for. Anything unreadable is refused rather than half understood: a
 * picture that quietly says nothing about AI use is the one outcome a creator cannot see.
 */
function readTraining(raw: string | undefined): TrainingConsent | undefined {
  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_TRAINING_FIELD_BYTES) {
    throw new BadRequest(`training must be a JSON object under ${MAX_TRAINING_FIELD_BYTES} bytes`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BadRequest('training must be a JSON object, such as {"aiTraining":"notAllowed"}');
  }

  const statement = trainingSchema.safeParse(parsed);
  if (!statement.success) {
    const detail = statement.error.issues
      .map((issue) => `${["training", ...issue.path].join(".")}: ${issue.message}`)
      .join("; ");
    throw new BadRequest(detail);
  }
  return statement.data;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
