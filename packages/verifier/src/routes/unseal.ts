import { APIError } from "@privy-io/node";
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { InvalidToken, bearerToken, verifyPrivyToken, type PrivyIdentity, type PrivyKeys } from "../auth/privy.js";
import { embeddedWallets } from "../auth/wallet.js";
import { readManifest } from "../c2pa.js";
import { MAX_UPLOAD_BYTES, env } from "../env.js";
import { ImageTooLarge, fingerprint, readImageHeader, type Fingerprint, type Hex } from "../fingerprint.js";
import { Busy } from "../generate/gate.js";
import { privy, privyErrorText } from "../generate/privy.js";
import { dailyQuota } from "../generate/quota.js";
import { deletePrivateFile, findPrivateByName, pinFile, pinJson, type PrivateListing } from "../ipfs/pinata.js";
import { takeToday } from "../limits/dayGate.js";
import { fileSlug, manifestDocument } from "../metadata.js";
import { UNSEAL_THUMBNAIL_TOO_LARGE_REASON, type PreparedImage } from "../prepare.js";
import { readClient } from "../reputation/registry.js";
import { privateThumbnailName } from "../sealed.js";
import {
  findUnsealRecord,
  fingerprintMatches,
  holderOf,
  isGatewayFailure,
  pinnedOut,
  printOut,
  readMetadataDocument,
  readPassport,
  readUnsealRecord,
  sealedStateOf,
  sha256Of,
  unsealRecord,
  unsealRecordName,
  unsealThumbnail,
  type OnChainPassport,
  type PinnedRecord,
  type ThumbnailAttempt,
  type UnsealRecord,
} from "../unseal.js";
import type { PrivateCopyStatus } from "./sealed.js";
import { BadRequest, statusOf } from "./shared.js";

/** The header parsed, so this is a real picture, but the pixels behind it did not decode. */
const UNDECODABLE = "the file could not be decoded";

const passportSchema = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{64}$/, "passportId must be 0x followed by 64 hex characters");

interface Upload {
  bytes: Buffer;
  passportId: Hex;
}

/**
 * Records this server has already found, kept for ever on purpose.
 *
 * An unseal record is pinned once and never changes, so a hit can never go stale: the only thing
 * this cache can be wrong about is a record pinned after the miss, and a miss is never cached. It
 * exists because a passport page is read far more often than a passport is unsealed, and every
 * miss costs one Pinata request out of the account's shared minute.
 *
 * One map per server rather than one per module, so two servers in one test file never answer from
 * each other's memory.
 */
type Known = Map<Hex, { record: UnsealRecord; pinned: PinnedRecord }>;

/**
 * POST /unseal: the holder of a sealed passport publishes the picture it committed to.
 *
 * A sealed passport is a hash on chain with no picture behind it. Unsealing is the creator handing
 * that picture over: they upload the signed file they kept, this service checks it is the very file
 * the passport commits to, and pins it publicly. Nothing about the passport on chain changes,
 * because nothing about it can: the registry writes metadataURI once and has no setter.
 *
 * Two invariants from kitchen/design/sealed-passports-threat-model.md live here.
 *
 * Invariant 5, only the holder unseals: the caller's Privy token resolves to a user id, the user
 * record names their embedded wallets, and `ownerOf` on the registry has to be one of them at the
 * moment of the request. The wallet never comes from the body.
 *
 * Invariant 6, unsealing publishes exactly what was registered: the sha-256 of the upload must be
 * the passport id, and the fingerprint recomputed from it must be the one the chain recorded. Both
 * are checked before a single byte is pinned, so a caller holding a different picture publishes
 * nothing.
 *
 * Two more refusals come from the model's own notes. A passport whose metadata document is already
 * public cannot be unsealed again, and a picture whose thumbnail will not fit the Chainlink fetch
 * budget is refused rather than published as a passport the workflow could never re-check.
 *
 * Once the picture and its record are public, a private copy kept for a private re-check has no
 * reason left to exist, so it is deleted by its exact name and the private copy status memory is
 * told to forget the passport. That step never changes the answer: a lookup or delete that fails is
 * logged with the passport id and the copy stays until the holder or an operator deletes it.
 *
 * Answers 401 for a missing or foreign token, 400 for the fields or a hash or fingerprint that does
 * not match, 403 `not-holder`, 404 `no-passport`, 409 `not-sealed` or `already-unsealed`, 413 and
 * 415 for the image, 422 `thumbnail-too-large`, 429 for the caller's own allowance and for today's
 * ceiling, 502 `pin-failed`, `record-pin-failed`, `chain-unavailable`, `metadata-unavailable` or
 * `privy-unavailable`, and 503 `busy`.
 */
export async function unsealRoutes(
  app: FastifyInstance,
  options: { keys?: PrivyKeys; copies?: PrivateCopyStatus } = {},
): Promise<void> {
  const quota = dailyQuota(env.EDITS_PER_DAY);
  const chain = readClient();
  const registry = env.MOOLAM_REGISTRY_ADDRESS as Hex;
  const known: Known = new Map();

  app.post("/unseal", async (request: FastifyRequest, reply: FastifyReply) => {
    const identity = await identify(request, options.keys);
    if (identity === undefined) {
      request.log.warn({ ip: request.ip, url: request.url }, "rejected: /unseal unauthorized");
      return reply.code(401).send({ error: "unauthorized" });
    }

    let upload: Upload;
    try {
      upload = await readUnsealUpload(request);
    } catch (error) {
      const status = statusOf(error);
      const reason = error instanceof Error ? error.message : String(error);
      // The reason names the field or the limit and never the upload, which is the picture itself.
      request.log.warn({ ip: request.ip, url: request.url, status, reason }, "rejected: /unseal");
      return reply.code(status).send({ error: reason });
    }

    return await open(app, request, reply, identity, upload, { quota, chain, registry, known, copies: options.copies });
  });

  /**
   * GET /unseal/:passportId: where the picture of an unsealed passport lives, or that there is
   * none yet.
   *
   * The passport page cannot learn this from the chain, so it asks here. The answer carries the
   * record's own address as well as the three it names, so a reader who does not want to take this
   * service's word for it can open the record on IPFS and hash the picture themselves.
   */
  app.get("/unseal/:passportId", async (request: FastifyRequest, reply: FastifyReply) => {
    // Nothing sets no-store here: the server's own hook names this path, so the answers no handler
    // writes, including the rate limiter's 429, carry it too.
    const parsed = passportSchema.safeParse((request.params as { passportId?: string }).passportId);
    if (!parsed.success) {
      return reply.code(400).send({ error: "passportId must be 0x followed by 64 hex characters" });
    }
    const passportId = parsed.data.toLowerCase() as Hex;

    const remembered = known.get(passportId);
    if (remembered !== undefined) {
      return reply.send(answerFor(passportId, remembered.record, remembered.pinned));
    }

    const found = await findUnsealRecord(passportId);
    if (found.state === "unavailable") {
      request.log.warn({ url: request.url, reason: found.reason }, "/unseal: the record lookup could not answer");
      return reply.code(503).send({ error: "lookup-unavailable" });
    }
    if (found.state === "none") {
      return reply.code(404).send({ error: "not-unsealed", passportId });
    }

    let record: UnsealRecord;
    try {
      record = await readUnsealRecord(found.record.uri, passportId);
    } catch (error) {
      request.log.warn(
        { url: request.url, cid: found.record.cid, reason: reasonOf(error) },
        "/unseal: a record was listed but could not be read",
      );
      return reply.code(503).send({ error: "lookup-unavailable" });
    }

    known.set(passportId, { record, pinned: found.record });
    return reply.send(answerFor(passportId, record, found.record));
  });
}

interface UnsealContext {
  quota: ReturnType<typeof dailyQuota>;
  chain: ReturnType<typeof readClient>;
  registry: Hex;
  known: Known;
  /** The memory behind /sealed/status, so a deleted private copy reads gone at once. */
  copies?: PrivateCopyStatus;
}

/**
 * Everything from the caller's token to the four files on IPFS.
 *
 * The order is the one the other spending routes use, for the same reason: the checks that cost
 * nothing settle first, then the caller's own allowance and the day's ceiling for everyone, and
 * only then the decode and the pins. A creator who pressed the button on the wrong passport, or on
 * one that is already public, is told so without this service decoding a 20 MB picture for them.
 *
 * Both allowances go back whenever nothing was pinned, because an unseal sends no transaction: a
 * request that pinned nothing has cost the world nothing to give back.
 */
async function open(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  identity: PrivyIdentity,
  upload: Upload,
  context: UnsealContext,
): Promise<FastifyReply> {
  // Invariant 6, first half. It is the cheapest check in the route and the one that catches the
  // common mistake: the creator kept a copy of the picture rather than the file this service
  // signed and handed back, and the two are different bytes.
  const uploaded = sha256Of(upload.bytes);
  if (uploaded !== upload.passportId) {
    request.log.warn(
      { url: request.url, user: identity.userId, passportId: upload.passportId },
      "rejected: /unseal the upload is not the registered file",
    );
    return reply.code(400).send({ error: "hash-mismatch", passportId: upload.passportId });
  }

  let passport: OnChainPassport | undefined;
  try {
    passport = await readPassport(context.chain, context.registry, upload.passportId);
  } catch (error) {
    request.log.error({ url: request.url, reason: reasonOf(error) }, "rejected: /unseal the chain did not answer");
    return reply.code(502).send({ error: "chain-unavailable" });
  }
  if (passport === undefined) {
    request.log.warn({ url: request.url, passportId: upload.passportId }, "rejected: /unseal unknown passport");
    return reply.code(404).send({ error: "no-passport", passportId: upload.passportId });
  }

  // Invariant 5. The wallets come from the Privy user record and the holder from the chain, so a
  // caller cannot name an address and cannot use an index's idea of who owns this from a minute ago.
  let wallets: Hex[];
  try {
    wallets = await embeddedWallets(privy(), identity.userId);
  } catch (error) {
    if (error instanceof APIError && error.status === 404) {
      request.log.warn({ url: request.url, user: identity.userId }, "rejected: /unseal unknown user");
      return reply.code(403).send({ error: "not-holder" });
    }
    request.log.error(
      { url: request.url, reason: privyErrorText(error) },
      "rejected: /unseal the wallet lookup failed",
    );
    return reply.code(502).send({ error: "privy-unavailable" });
  }

  let holder: Hex;
  try {
    holder = await holderOf(context.chain, context.registry, upload.passportId);
  } catch (error) {
    request.log.error({ url: request.url, reason: reasonOf(error) }, "rejected: /unseal the chain did not answer");
    return reply.code(502).send({ error: "chain-unavailable" });
  }
  if (!wallets.includes(holder)) {
    request.log.warn(
      { url: request.url, user: identity.userId, passportId: upload.passportId, wallets: wallets.length },
      "rejected: /unseal the caller does not hold this passport",
    );
    return reply.code(403).send({ error: "not-holder" });
  }

  let document: unknown;
  try {
    document = await readMetadataDocument(passport.metadataURI);
  } catch (error) {
    const reason = reasonOf(error);
    request.log.error(
      { url: request.url, reason, gateway: isGatewayFailure(error) },
      "rejected: /unseal the metadata document could not be read",
    );
    return reply.code(502).send({ error: "metadata-unavailable" });
  }

  const state = sealedStateOf(document);
  if (state === "unreadable") {
    request.log.error(
      { url: request.url, passportId: upload.passportId },
      "rejected: /unseal the metadata document does not say whether it is sealed",
    );
    return reply.code(502).send({ error: "metadata-unavailable" });
  }
  if (state === "public") {
    request.log.warn({ url: request.url, passportId: upload.passportId }, "rejected: /unseal already public");
    return reply.code(409).send({ error: "not-sealed", passportId: upload.passportId });
  }

  const existing = await findUnsealRecord(upload.passportId);
  if (existing.state === "found") {
    request.log.warn(
      { url: request.url, passportId: upload.passportId, cid: existing.record.cid },
      "rejected: /unseal already unsealed",
    );
    return reply.code(409).send({
      error: "already-unsealed",
      passportId: upload.passportId,
      record: pinnedOut(existing.record.uri, existing.record.cid),
    });
  }
  if (existing.state === "unavailable") {
    // Going on is the safe way to be wrong here. Every pin below is content addressed, so a second
    // unseal of the same picture by the same holder lands on the very same addresses and Pinata
    // stores one copy; refusing instead would let a Pinata outage lock every creator out.
    request.log.warn(
      { url: request.url, passportId: upload.passportId, reason: existing.reason },
      "/unseal: could not check for an existing record, going on",
    );
  }

  const reservation = context.quota.take(identity.userId);
  if (!reservation.ok || reservation.ticket === undefined) {
    request.log.warn({ url: request.url, user: identity.userId }, "rejected: /unseal quota");
    return reply.code(429).send({ error: "quota", quota: reservation.state });
  }
  const ticket = reservation.ticket;

  const today = takeToday(app, request, reply, "unseals", () => {
    context.quota.release(identity.userId, ticket);
  });
  if (!today.ok) {
    return today.refused;
  }

  let pinned = false;
  try {
    try {
      await readImageHeader(upload.bytes);
    } catch (error) {
      const tooBig = error instanceof ImageTooLarge;
      const reason = error instanceof Error ? error.message : String(error);
      request.log.warn({ url: request.url, reason }, "rejected: /unseal image");
      return reply.code(tooBig ? 413 : 415).send({ error: tooBig ? reason : "not-an-image" });
    }

    // Both decodes queue behind the same gate as matching and preparing, in one slot rather than
    // two, so an unseal of a large picture neither decodes several at once nor joins the queue
    // twice. The thumbnail is only made when the fingerprint agreed, because a picture that is not
    // the registered one is refused whatever its thumbnail would have weighed.
    let work: { print: Fingerprint; thumbnail?: ThumbnailAttempt };
    try {
      work = await app.verifier.runPrepare(async () => {
        const print = await fingerprint(upload.bytes);
        if (!fingerprintMatches(print, passport)) {
          return { print };
        }
        return { print, thumbnail: await unsealThumbnail(upload.bytes) };
      });
    } catch (error) {
      if (error instanceof Busy) {
        request.log.warn({ url: request.url }, "rejected: /unseal busy");
        return reply.code(503).send({ error: "busy" });
      }
      request.log.warn({ url: request.url, reason: reasonOf(error) }, "rejected: /unseal undecodable image");
      return reply.code(415).send({ error: "not-an-image", reason: UNDECODABLE });
    }

    const print = work.print;
    // Invariant 6, second half.
    if (work.thumbnail === undefined) {
      request.log.warn(
        { url: request.url, passportId: upload.passportId, version: passport.fingerprintVersion },
        "rejected: /unseal the recomputed fingerprint is not the registered one",
      );
      return reply.code(400).send({
        error: "fingerprint-mismatch",
        passportId: upload.passportId,
        recomputed: printOut(print),
      });
    }

    const attempt = work.thumbnail;
    if (!attempt.ok) {
      // The threat model's own note: the sealed path makes no thumbnail, so a picture the public
      // path would have refused can be registered sealed. Publishing it now would leave a passport
      // the Chainlink workflow can never fetch, which reads as a fault for ever.
      request.log.warn({ url: request.url, reason: attempt.detail }, "rejected: /unseal thumbnail too large");
      return reply.code(422).send({
        error: "thumbnail-too-large",
        limit: attempt.limit,
        reason: UNSEAL_THUMBNAIL_TOO_LARGE_REASON,
      });
    }
    const thumbnail = attempt.thumbnail;

    const manifest = await readManifest(upload.bytes);
    const doc =
      manifest.present && manifest.manifestHash !== undefined
        ? manifestDocument({
            original: upload.bytes,
            thumbnail,
            fingerprint: print,
            manifestHash: manifest.manifestHash,
            manifest,
          } satisfies PreparedImage)
        : undefined;

    const slug = fileSlug(titleOf(document), upload.passportId);
    const [imagePin, thumbnailPin, manifestPin] = await Promise.allSettled([
      pinFile(upload.bytes, `${slug}.jpg`, "image/jpeg"),
      pinFile(thumbnail, `${slug}-thumb.jpg`, "image/jpeg"),
      doc === undefined ? Promise.resolve(undefined) : pinJson(doc, `${slug}-c2pa.json`),
    ]);
    const attempted = [imagePin, thumbnailPin, manifestPin];
    pinned = attempted.some((one) => one.status === "fulfilled" && one.value !== undefined);

    if (imagePin.status === "rejected" || thumbnailPin.status === "rejected" || manifestPin.status === "rejected") {
      request.log.error(
        {
          url: request.url,
          reason: attempted
            .filter((one) => one.status === "rejected")
            .map((one) => reasonOf(one.reason))
            .join("; "),
          landed: attempted.filter((one) => one.status === "fulfilled" && one.value !== undefined).length,
        },
        "rejected: /unseal pin failed",
      );
      return reply.code(502).send({ error: "pin-failed" });
    }

    const image = imagePin.value;
    const thumb = thumbnailPin.value;
    const published = {
      image: pinnedOut(image.uri, image.cid),
      thumbnail: pinnedOut(thumb.uri, thumb.cid),
      manifest: manifestPin.value === undefined ? undefined : pinnedOut(manifestPin.value.uri, manifestPin.value.cid),
    };

    const record = unsealRecord({
      passportId: upload.passportId,
      image: image.uri,
      thumbnail: thumb.uri,
      manifest: manifestPin.value?.uri,
      unsealedBy: holder,
    });

    let pinnedRecord;
    try {
      pinnedRecord = await pinJson(record, unsealRecordName(upload.passportId));
    } catch (error) {
      // The picture is public and the record that points at it is not, which is the one half-done
      // state this route can end in. The answer says exactly that rather than a bare failure,
      // because the caller has to know their picture is already out there. A second attempt lands
      // on the same three addresses and finishes the record.
      request.log.error(
        { url: request.url, passportId: upload.passportId, reason: reasonOf(error) },
        "rejected: /unseal the picture is pinned and the record is not",
      );
      return reply.code(502).send({
        error: "record-pin-failed",
        passportId: upload.passportId,
        reason:
          "the picture, its thumbnail and its manifest are published, and the record that points at them is not. Send the same file again to finish it: nothing is pinned twice.",
        ...published,
      });
    }

    const pinnedAt: PinnedRecord = { cid: pinnedRecord.cid, uri: pinnedRecord.uri };
    context.known.set(upload.passportId, { record, pinned: pinnedAt });

    await forgetPrivateCopy(upload.passportId, request.log, context.copies);

    request.log.info(
      { user: identity.userId, passportId: upload.passportId, image: image.cid, record: pinnedRecord.cid },
      "unseal: published",
    );

    return reply.send({
      passportId: upload.passportId,
      ...published,
      record: pinnedOut(pinnedRecord.uri, pinnedRecord.cid),
      unsealedBy: record.unsealedBy,
      unsealedAt: record.unsealedAt,
      fingerprint: printOut(print),
      quota: context.quota.state(identity.userId),
    });
  } finally {
    if (!pinned) {
      context.quota.release(identity.userId, ticket);
      today.slot.giveBack();
    }
  }
}

/**
 * Deletes every private file named exactly after this passport, now that the picture is public.
 *
 * The name comes from the passport id the upload hashed to, never from the document (B1), and the
 * listing is filtered on the whole name here as well as inside the Pinata client (B3), so a file
 * whose name only starts the same is never touched. The listing pages at most five pages before it
 * refuses to answer, which bounds the loop. The status memory is dropped whatever happened, so the
 * next /sealed/status read goes back to Pinata. Never throws: a failure is logged with the passport
 * id and a count, never a file id, and the unseal answers exactly as it would have.
 */
async function forgetPrivateCopy(passportId: Hex, log: FastifyBaseLogger, copies?: PrivateCopyStatus): Promise<void> {
  const name = privateThumbnailName(passportId);
  try {
    let files: PrivateListing[];
    try {
      files = (await findPrivateByName(name)).filter((file) => file.name === name);
    } catch (error) {
      log.error({ passportId, reason: reasonOf(error) }, "unseal: could not look for a private copy, it stays");
      return;
    }

    let deleted = 0;
    let failed = 0;
    for (const file of files) {
      try {
        await deletePrivateFile(file.id);
        deleted += 1;
      } catch {
        failed += 1;
      }
    }
    if (failed > 0) {
      log.error({ passportId, deleted, failed }, "unseal: the private copy was only partly deleted");
    } else if (deleted > 0) {
      log.info({ passportId, deleted }, "unseal: private copy deleted, the picture is public");
    }
  } finally {
    copies?.drop(passportId);
  }
}

/** What a GET answers, built the same way from a fresh lookup and from the cache. */
function answerFor(passportId: Hex, record: UnsealRecord, pinned: PinnedRecord): Record<string, unknown> {
  return {
    passportId,
    image: pinnedOut(record.image, cidOf(record.image)),
    thumbnail: pinnedOut(record.thumbnail, cidOf(record.thumbnail)),
    manifest: record.manifest === undefined ? undefined : pinnedOut(record.manifest, cidOf(record.manifest)),
    record: pinnedOut(pinned.uri, pinned.cid),
    unsealedBy: record.unsealedBy,
    unsealedAt: record.unsealedAt,
  };
}

/** The content id inside an ipfs:// address. The schema has already insisted on the scheme. */
function cidOf(uri: string): string {
  return uri.slice("ipfs://".length);
}

/**
 * The title for the file names, taken from the sealed document the creator already signed.
 *
 * The request does not carry a title on purpose: the passport's name was fixed at registration and
 * letting a caller send a new one here would put words of their choosing on a file that stands for
 * a picture the chain committed to months ago.
 */
function titleOf(document: unknown): string {
  const name = (document as { name?: unknown } | null)?.name;
  return typeof name === "string" && name.trim().length > 0 ? name : "moolam";
}

/**
 * Reads the file and the passport id out of the multipart body, in whatever order they arrive.
 *
 * Throws BadRequest: 413 over the byte limit, 400 for a missing file, a file part under another
 * name, or a passport id that is not 32 bytes of hex.
 */
async function readUnsealUpload(request: FastifyRequest): Promise<Upload> {
  if (!request.isMultipart()) {
    throw new BadRequest('send the signed file in a multipart field named "file"');
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
      throw new BadRequest(`the file is larger than the ${MAX_UPLOAD_BYTES} byte limit`, 413);
    }
    throw error;
  }

  if (bytes === undefined || bytes.length === 0) {
    throw new BadRequest('send the signed file in a multipart field named "file"');
  }

  const passportId = passportSchema.safeParse(fields.get("passportId"));
  if (!passportId.success) {
    throw new BadRequest('send a "passportId" field of 0x followed by 64 hex characters');
  }

  return { bytes, passportId: passportId.data.toLowerCase() as Hex };
}

/**
 * Who sent this request, or undefined when the token is missing, expired or from another Privy
 * app. Anything wrong with it is a 401 and never a 500.
 */
async function identify(request: FastifyRequest, keys?: PrivyKeys): Promise<PrivyIdentity | undefined> {
  const token = bearerToken(request.headers.authorization);
  if (token === undefined) return undefined;
  try {
    return await verifyPrivyToken(token, keys);
  } catch (error) {
    if (error instanceof InvalidToken) {
      request.log.warn({ ip: request.ip, reason: error.message }, "rejected: bad Privy token");
      return undefined;
    }
    throw error;
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
