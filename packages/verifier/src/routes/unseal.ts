import { APIError } from "@privy-io/node";
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { InvalidToken, bearerToken, verifyPrivyToken, type PrivyIdentity, type PrivyKeys } from "../auth/privy.js";
import { embeddedWallets } from "../auth/wallet.js";
import { readManifest } from "../c2pa.js";
import { MAX_UPLOAD_BYTES, env } from "../env.js";
import {
  FingerprintFault,
  ImageTooLarge,
  fingerprint,
  readImageHeader,
  type Fingerprint,
  type Hex,
} from "../fingerprint.js";
import { Busy } from "../generate/gate.js";
import { privy, privyErrorText } from "../generate/privy.js";
import { dailyQuota } from "../generate/quota.js";
import {
  PinNotConfirmed,
  contentIdOf,
  deletePrivateFile,
  findPrivateByName,
  pinFile,
  pinJson,
  type PrivateListing,
} from "../ipfs/pinata.js";
import { takeToday } from "../limits/dayGate.js";
import { fileSlug, manifestDocument } from "../metadata.js";
import {
  FINGERPRINT_UNSTABLE_REASON,
  FingerprintUnstable,
  UNSEAL_THUMBNAIL_TOO_LARGE_REASON,
  assertStableFingerprint,
  type PreparedImage,
} from "../prepare.js";
import { readClient } from "../reputation/registry.js";
import { privateRecheckFor, privateThumbnailName, refusedByPinata } from "../sealed.js";
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
import { BadRequest, SERVICE_FAULT_REASON, statusOf } from "./shared.js";

/** The header parsed, so this is a real picture, but the pixels behind it did not decode. */
const UNDECODABLE = "the file could not be decoded";

/** GET /unseal/:passportId per address, the same as /sealed/status: a miss spends a Pinata request. */
const LOOKUPS_PER_MINUTE = 30;

/**
 * How long a miss is held. A holder can unseal at any moment, and this server's own unseal clears
 * the miss at once, so a minute is the longest another server's answer can lag behind.
 */
const MISS_TTL_MS = 60_000;

/** How many misses are held at once before the oldest is forgotten. */
const MISS_MAX_ENTRIES = 2_000;

/**
 * How long after its own unseal this server never remembers a not-unsealed miss for the passport,
 * when it could not tell which record is the oldest. Pinata's listing can trail a fresh pin, and a
 * miss remembered from that trailing listing would call the passport sealed for a minute while its
 * picture is public (review pass 7, V65). Ten minutes is far past any lag seen in the listing.
 */
const FRESH_UNSEAL_MS = 10 * 60_000;

type MissAnswer = { error: "no-passport" | "not-sealed" | "not-unsealed"; passportId: Hex };

interface MissMemory {
  /** The answer held for this passport, or undefined when there is none or it has run out. */
  get: (passportId: Hex) => MissAnswer | undefined;
  /** Holds the answer and hands it back, so a route can remember and send in one line. */
  remember: (passportId: Hex, answer: MissAnswer) => MissAnswer;
  forget: (passportId: Hex) => void;
}

/** Passports this server has just unsealed without knowing their oldest record. */
interface FreshUnseals {
  hold: (passportId: Hex) => void;
  has: (passportId: Hex) => boolean;
}

function freshUnseals(now: () => number = () => Date.now()): FreshUnseals {
  const until = new Map<Hex, number>();
  return {
    hold: (passportId) => {
      until.delete(passportId);
      while (until.size >= MISS_MAX_ENTRIES) {
        const oldest = until.keys().next();
        if (oldest.done === true) break;
        until.delete(oldest.value);
      }
      until.set(passportId, now() + FRESH_UNSEAL_MS);
    },
    has: (passportId) => {
      const end = until.get(passportId);
      if (end === undefined) return false;
      if (end > now()) return true;
      until.delete(passportId);
      return false;
    },
  };
}

function missMemory(now: () => number = () => Date.now()): MissMemory {
  const held = new Map<Hex, { answer: MissAnswer; until: number }>();
  return {
    get: (passportId) => {
      const entry = held.get(passportId);
      if (entry === undefined) return undefined;
      if (entry.until > now()) return entry.answer;
      held.delete(passportId);
      return undefined;
    },
    remember: (passportId, answer) => {
      held.delete(passportId);
      while (held.size >= MISS_MAX_ENTRIES) {
        const oldest = held.keys().next();
        if (oldest.done === true) break;
        held.delete(oldest.value);
      }
      held.set(passportId, { answer, until: now() + MISS_TTL_MS });
      return answer;
    },
    forget: (passportId) => {
      held.delete(passportId);
    },
  };
}

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
 * Two of the sealed promises in docs/security/threat-model.md live here.
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
 * A public pin counts only when Pinata answers with the content id of the bytes sent, on the
 * public network (V11). The thumbnail is pinned first and alone, and when Pinata answers it with a
 * private file the unseal stops with 409 `thumbnail-held-privately` and nothing public (review pass
 * 6, V52). When one of the other pins fails, the answer names which pieces are public and which are
 * not, nothing private is touched, the holder's allowance comes back, and sending the same file
 * again lands on the same content ids and finishes the unseal (V9). A private copy kept
 * before V12 is the public thumbnail byte for byte, so it is deleted before the pins, or nothing is
 * pinned (review pass 5). When the check for an earlier record found none, the record just pinned is
 * cached for GET at once. When that check could not answer, the record cached for GET is the oldest
 * one a fresh lookup names, or none, and for ten minutes GET remembers no not-unsealed miss for it.
 *
 * Answers 401 for a missing or foreign token, 400 for the fields or a hash or fingerprint that does
 * not match, 403 `not-holder`, 404 `no-passport`, 409 `not-sealed`, `already-unsealed`,
 * `unseal-in-progress` or `thumbnail-held-privately`, 413 and 415 for the image, 422
 * `thumbnail-too-large` or `fingerprint-unstable`, 429 for the caller's own allowance, for today's
 * ceiling and past 30 a minute from one address, 502 `pin-failed`, `record-pin-failed`,
 * `chain-unavailable`, `metadata-unavailable` or `privy-unavailable`, and 503 `busy` or
 * `service-fault` when this service failed to read or fingerprint the file.
 */
export async function unsealRoutes(
  app: FastifyInstance,
  options: {
    keys?: PrivyKeys;
    copies?: PrivateCopyStatus;
    /** False leaves POST /unseal off, on a host that cannot read a holder's wallets from Privy. */
    holder?: boolean;
  } = {},
): Promise<void> {
  const quota = dailyQuota(env.EDITS_PER_DAY);
  const chain = readClient();
  const registry = env.MOOLAM_REGISTRY_ADDRESS as Hex;
  const known: Known = new Map();
  const misses = missMemory();
  const fresh = freshUnseals();
  const unsealing = new Set<Hex>();

  const publish = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
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

    return await open(app, request, reply, identity, upload, {
      quota,
      chain,
      registry,
      known,
      misses,
      fresh,
      unsealing,
      copies: options.copies,
    });
  };
  if (options.holder !== false) {
    // The GET route's limit, because a refused resend still costs a Privy read and a chain read
    // (review pass 6, V54).
    app.post("/unseal", { config: { rateLimit: { max: LOOKUPS_PER_MINUTE, timeWindow: "1 minute" } } }, publish);
  }

  /**
   * GET /unseal/:passportId: where the picture of an unsealed passport lives, or that there is
   * none yet.
   *
   * The passport page cannot learn this from the chain, so it asks here. The answer carries the
   * record's own address as well as the three it names, so a reader who does not want to take this
   * service's word for it can open the record on IPFS and hash the picture themselves.
   *
   * Every miss costs one request out of the Pinata account's shared minute, so the listing is asked
   * only for a passport the index or the chain holds and whose document says sealed. A miss of any
   * kind (no passport, never sealed, no record) is remembered for MISS_TTL_MS, a record for good,
   * and the route has its own limit of LOOKUPS_PER_MINUTE per address, the one /sealed/status has.
   *
   * Answers 400 for an id that is not 32 bytes of hex, 404 `no-passport`, `not-sealed` or
   * `not-unsealed`, 429 past the limit, and 503 `lookup-unavailable` when the chain, the document
   * or Pinata could not say.
   */
  app.get(
    "/unseal/:passportId",
    { config: { rateLimit: { max: LOOKUPS_PER_MINUTE, timeWindow: "1 minute" } } },
    async (request: FastifyRequest, reply: FastifyReply) => {
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
      const missed = misses.get(passportId);
      if (missed !== undefined) {
        return reply.code(404).send(missed);
      }

      // Pinata is asked only about a passport that exists and whose document says sealed, because
      // only that passport can have an unseal record. A made-up id costs a chain read at most.
      let metadataURI: string;
      const indexed = app.verifier.lookupExact(passportId);
      if (indexed !== undefined) {
        metadataURI = indexed.metadataURI;
      } else {
        let passport: OnChainPassport | undefined;
        try {
          passport = await readPassport(chain, registry, passportId);
        } catch (error) {
          request.log.warn({ url: request.url, reason: reasonOf(error) }, "/unseal: the chain did not answer");
          return reply.code(503).send({ error: "lookup-unavailable" });
        }
        if (passport === undefined) {
          return reply.code(404).send(misses.remember(passportId, { error: "no-passport", passportId }));
        }
        metadataURI = passport.metadataURI;
      }

      let state: ReturnType<typeof sealedStateOf>;
      try {
        state = sealedStateOf(await readMetadataDocument(metadataURI));
      } catch (error) {
        request.log.warn({ url: request.url, reason: reasonOf(error) }, "/unseal: the passport's document could not be read");
        return reply.code(503).send({ error: "lookup-unavailable" });
      }
      if (state === "unreadable") {
        return reply.code(503).send({ error: "lookup-unavailable" });
      }
      if (state === "public") {
        return reply.code(404).send(misses.remember(passportId, { error: "not-sealed", passportId }));
      }

      const found = await findUnsealRecord(passportId);
      if (found.state === "unavailable") {
        request.log.warn({ url: request.url, reason: found.reason }, "/unseal: the record lookup could not answer");
        return reply.code(503).send({ error: "lookup-unavailable" });
      }
      if (found.state === "none") {
        const miss: MissAnswer = { error: "not-unsealed", passportId };
        // A listing that trails this server's own fresh unseal is not believed for long.
        return reply.code(404).send(fresh.has(passportId) ? miss : misses.remember(passportId, miss));
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
    },
  );
}

interface UnsealContext {
  quota: ReturnType<typeof dailyQuota>;
  chain: ReturnType<typeof readClient>;
  registry: Hex;
  known: Known;
  misses: MissMemory;
  /** Passports unsealed here whose oldest record this server could not confirm, for FRESH_UNSEAL_MS. */
  fresh: FreshUnseals;
  /** Passports with an unseal running on this server, so two never pin two records (review pass 6, V55). */
  unsealing: Set<Hex>;
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
 * A passport this server has already seen unsealed is answered from memory before any Privy,
 * Pinata or chain call (review pass 6, V54), and only one unseal of a passport runs at a time on
 * this server (V55).
 *
 * Both allowances go back whenever no pin can have landed, because an unseal sends no transaction:
 * a request that stored nothing has cost the world nothing to give back. A pin that failed after
 * its bytes left this process may still have been stored, so only Pinata's own refusal, or a
 * request never sent, counts as nothing landed, the rule /prepare and /edit follow (review pass 6,
 * intake 4).
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

  // An unseal record never changes, and GET /unseal/:passportId serves this same memory to anyone.
  const remembered = context.known.get(upload.passportId);
  if (remembered !== undefined) {
    request.log.warn(
      { url: request.url, passportId: upload.passportId, cid: remembered.pinned.cid },
      "rejected: /unseal already unsealed",
    );
    return reply.code(409).send({
      error: "already-unsealed",
      passportId: upload.passportId,
      record: pinnedOut(remembered.pinned.uri, remembered.pinned.cid),
    });
  }

  // Taken after the hash check, so only a caller holding the registered file can hold it, and held
  // until this request has answered, so a second one cannot read "no record" while the first pins.
  if (context.unsealing.has(upload.passportId)) {
    request.log.warn({ url: request.url, passportId: upload.passportId }, "rejected: /unseal already running");
    return reply.code(409).send({ error: "unseal-in-progress", passportId: upload.passportId });
  }
  context.unsealing.add(upload.passportId);
  try {
    return await unsealHeld(app, request, reply, identity, upload, context);
  } finally {
    context.unsealing.delete(upload.passportId);
  }
}

/** The rest of an unseal, from the chain read to the record, with this passport's unseal held. */
async function unsealHeld(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  identity: PrivyIdentity,
  upload: Upload,
  context: UnsealContext,
): Promise<FastifyReply> {
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
  let completed = false;
  try {
    try {
      await readImageHeader(upload.bytes);
    } catch (error) {
      if (error instanceof FingerprintFault) {
        request.log.error(
          { url: request.url, reason: error.message },
          "rejected: /unseal the service failed reading the image",
        );
        return reply.code(503).send({ error: "service-fault", reason: SERVICE_FAULT_REASON });
      }
      const tooBig = error instanceof ImageTooLarge;
      const reason = error instanceof Error ? error.message : String(error);
      request.log.warn({ url: request.url, reason }, "rejected: /unseal image");
      return reply.code(tooBig ? 413 : 415).send({ error: tooBig ? reason : "not-an-image" });
    }

    // Both decodes queue behind the same gate as matching and preparing, in one slot rather than
    // two, so an unseal of a large picture neither decodes several at once nor joins the queue
    // twice. The thumbnail is only made when the fingerprint agreed, because a picture that is not
    // the registered one is refused whatever its thumbnail would have weighed. The thumbnail that
    // will be published is then held to the check /prepare makes: a picture registered sealed
    // before that check, or drawn by /generate, can have a fingerprint its own thumbnail does not
    // keep, and publishing it would leave a passport the re-check reads mismatched for good
    // (review pass 6, V50).
    let work: { print: Fingerprint; thumbnail?: ThumbnailAttempt; unstable?: FingerprintUnstable };
    try {
      work = await app.verifier.runPrepare(async () => {
        const print = await fingerprint(upload.bytes);
        if (!fingerprintMatches(print, passport)) {
          return { print };
        }
        const thumbnail = await unsealThumbnail(upload.bytes);
        if (!thumbnail.ok) {
          return { print, thumbnail };
        }
        try {
          await assertStableFingerprint(print.phash, thumbnail.thumbnail);
        } catch (error) {
          if (error instanceof FingerprintUnstable) {
            return { print, thumbnail, unstable: error };
          }
          throw error;
        }
        return { print, thumbnail };
      });
    } catch (error) {
      if (error instanceof Busy) {
        request.log.warn({ url: request.url }, "rejected: /unseal busy");
        return reply.code(503).send({ error: "busy" });
      }
      // This service failed to fingerprint the file it was handed, so the file is not to blame
      // (review pass 6, answers 7). Nothing was pinned, so the holder's allowance and the day's
      // slot both come back.
      if (error instanceof FingerprintFault) {
        request.log.error(
          { url: request.url, reason: error.message },
          "rejected: /unseal the service failed fingerprinting",
        );
        return reply.code(503).send({ error: "service-fault", reason: SERVICE_FAULT_REASON });
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
    if (work.unstable !== undefined) {
      request.log.warn(
        { url: request.url, passportId: upload.passportId, distance: work.unstable.distance },
        "rejected: /unseal fingerprint unstable",
      );
      return reply.code(422).send({
        error: "fingerprint-unstable",
        limit: work.unstable.limit,
        distance: work.unstable.distance,
        reason: FINGERPRINT_UNSTABLE_REASON,
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

    // A private copy kept before V12 is this very thumbnail, byte for byte, and Pinata answers the
    // public pin of bytes it already holds privately with the private file. It goes first, so the
    // three pins below can all land. Nothing is pinned when it is there and cannot be removed.
    const cleared = await clearPreV12Copy(upload.passportId, thumbnail, request.log, context.copies);
    if (!cleared) {
      return reply.code(502).send({
        error: "pin-failed",
        passportId: upload.passportId,
        published: {},
        failed: ["thumbnail"],
        reason:
          "nothing was published and the passport still reads sealed: an old private copy of the thumbnail could not be cleared first. Send the same file again to try once more.",
      });
    }

    const slug = fileSlug(titleOf(document), upload.passportId);
    // The thumbnail goes first and alone (review pass 6, V52). A private copy of these very bytes
    // under another passport's name, kept before V12, makes Pinata answer the public pin with that
    // private file, and clearPreV12Copy only looks under this passport's name. Pinned in parallel,
    // the full image would already be public by then; pinned first, the unseal stops with nothing
    // public.
    let thumb: Awaited<ReturnType<typeof pinFile>>;
    try {
      thumb = await pinFile(thumbnail, `${slug}-thumb.jpg`, "image/jpeg");
    } catch (error) {
      pinned = !refusedByPinata(error);
      const privately = heldPrivately(error);
      request.log.error(
        { url: request.url, passportId: upload.passportId, reason: reasonOf(error), privately },
        "rejected: /unseal thumbnail pin failed, nothing published",
      );
      if (privately) {
        return reply.code(409).send({
          error: "thumbnail-held-privately",
          passportId: upload.passportId,
          reason:
            "nothing was published and the passport still reads sealed: the storage service already keeps this picture's thumbnail as a private file, so it cannot be made public from here. Your allowance was not used.",
        });
      }
      return reply.code(502).send({
        error: "pin-failed",
        passportId: upload.passportId,
        published: {},
        failed: ["thumbnail"],
        reason: "nothing was published and the passport still reads sealed. Send the same file again to try once more.",
      });
    }
    pinned = true;

    const [imagePin, manifestPin] = await Promise.allSettled([
      pinFile(upload.bytes, `${slug}.jpg`, "image/jpeg"),
      doc === undefined ? Promise.resolve(undefined) : pinJson(doc, `${slug}-c2pa.json`),
    ]);

    if (imagePin.status === "rejected" || manifestPin.status === "rejected") {
      // Whatever landed is public now and cannot be taken back, so the holder is told exactly
      // which pieces those are. Nothing private is touched and no record is written, and a retry
      // with the same file lands on the same content ids and finishes the job.
      const landed: Partial<Record<Piece, ReturnType<typeof pinnedOut>>> = {
        thumbnail: pinnedOut(thumb.uri, thumb.cid),
      };
      const failed: Piece[] = [];
      for (const [piece, outcome] of [
        ["image", imagePin],
        ["manifest", manifestPin],
      ] as const) {
        if (outcome.status === "rejected") {
          failed.push(piece);
        } else if (outcome.value !== undefined) {
          landed[piece] = pinnedOut(outcome.value.uri, outcome.value.cid);
        }
      }
      request.log.error(
        {
          url: request.url,
          passportId: upload.passportId,
          reason: [imagePin, manifestPin]
            .filter((one) => one.status === "rejected")
            .map((one) => reasonOf(one.reason))
            .join("; "),
          landed: Object.keys(landed),
          failed,
        },
        "rejected: /unseal pin failed",
      );
      return reply.code(502).send({
        error: "pin-failed",
        passportId: upload.passportId,
        published: landed,
        failed,
        reason: `these pieces are public now and the rest are not: ${Object.keys(landed).join(", ")}. The passport still reads sealed. Send the same file again to finish it: nothing is pinned twice.`,
      });
    }

    const image = imagePin.value;
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
    if (existing.state === "none") {
      // The check before the pins found no record, and unseals of one passport run one at a time
      // here, so the record just pinned is the oldest. It is known at once, without asking a
      // listing that may not show it yet (review pass 7, V65).
      context.known.set(upload.passportId, { record, pinned: pinnedAt });
    } else {
      // The check could not tell, so another server can have pinned a record first. Every other
      // reader shows the oldest, so this server caches the oldest or nothing (review pass 6, V55),
      // and remembers no not-unsealed miss for a while, since the listing may trail this pin.
      const oldest = await oldestRecord(upload.passportId, pinnedAt, record, request.log);
      if (oldest !== undefined) {
        context.known.set(upload.passportId, oldest);
      }
      context.fresh.hold(upload.passportId);
    }
    context.misses.forget(upload.passportId);

    completed = true;
    // Every public pin above was confirmed against the bytes it carries, so the private copy is
    // deleted only now, and never a file whose content id is one of the published ones.
    const publicIds = new Set([image.cid, thumb.cid, manifestPin.value?.cid, pinnedRecord.cid].filter((cid) => cid !== undefined));
    await forgetPrivateCopy(
      upload.passportId,
      request.log,
      context.copies,
      publicIds,
      privateRecheckFor(document, upload.passportId) === "asked",
    );

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
    // The holder's own allowance comes back for any unseal that did not finish, so a partial one
    // can be finished; the day's ceiling for everyone comes back only when no pin can have landed.
    if (!completed) {
      context.quota.release(identity.userId, ticket);
    }
    if (!pinned) {
      today.slot.giveBack();
    }
  }
}

/**
 * Deletes every private file named exactly after this passport, now that the picture is public.
 *
 * The name comes from the passport id the upload hashed to, never from the document (B1), and the
 * listing is filtered on the whole name here as well as inside the Pinata client (B3), so a file
 * whose name only starts the same is never touched. A file whose content id is one the unseal has
 * just published is never touched either (V11). The listing pages at most five pages before it
 * refuses to answer, which bounds the loop. When every file under the name was deleted, the status
 * memory holds gone for its TTL, because Pinata's listing trails a delete and a read that went back
 * to it could remember "kept" for a minute (review pass 6, V51); a listing or a delete that failed
 * drops the memory, so the next read asks. Never throws: a failure is logged with the passport id
 * and a count, never a file id, and the unseal answers exactly as it would have.
 */
async function forgetPrivateCopy(
  passportId: Hex,
  log: FastifyBaseLogger,
  copies: PrivateCopyStatus | undefined,
  publicIds: ReadonlySet<string>,
  privateRecheck: boolean,
): Promise<void> {
  const name = privateThumbnailName(passportId);
  let listed: PrivateListing[];
  try {
    listed = (await findPrivateByName(name)).filter((file) => file.name === name);
  } catch (error) {
    log.error({ passportId, reason: reasonOf(error) }, "unseal: could not look for a private copy, it stays");
    copies?.drop(passportId);
    return;
  }
  const files = listed.filter((file) => !publicIds.has(file.cid));

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
  if (failed === 0 && files.length === listed.length) {
    copies?.gone(passportId, privateRecheck);
  } else {
    copies?.drop(passportId);
  }
}

/**
 * Deletes a private copy kept before V12 (commit ddf35fa), before the public pins.
 *
 * Such a copy is the raw makeThumbnail of the signed file, which is exactly the public thumbnail
 * built here, so it has the same content id, and Pinata answers the public pin of those bytes with
 * the private file: the thumbnail pin is refused on every retry while the picture itself goes out.
 * Only a file under this passport's exact name whose content id is the thumbnail's is touched, so a
 * copy made since V12, which carries the passport comment and so other bytes, stays until the
 * picture is public and forgetPrivateCopy runs.
 *
 * Answers false only when such a copy is there and could not be deleted, so the caller pins
 * nothing. A listing that fails answers true: the copy made then is far more often the new kind,
 * and refusing every unseal while Pinata's listing is down would lock every holder out. A pin that
 * then meets an old copy fails as it did before this check, and says so.
 */
async function clearPreV12Copy(
  passportId: Hex,
  thumbnail: Buffer,
  log: FastifyBaseLogger,
  copies: PrivateCopyStatus | undefined,
): Promise<boolean> {
  const name = privateThumbnailName(passportId);
  const cid = contentIdOf(thumbnail);
  let old: PrivateListing[];
  try {
    old = (await findPrivateByName(name)).filter((file) => file.name === name && file.cid === cid);
  } catch (error) {
    log.warn({ passportId, reason: reasonOf(error) }, "unseal: could not look for an old private copy, going on");
    return true;
  }
  if (old.length === 0) {
    return true;
  }

  try {
    for (const file of old) {
      await deletePrivateFile(file.id);
    }
  } catch (error) {
    log.error({ passportId, reason: reasonOf(error) }, "unseal: an old private copy could not be cleared, nothing pinned");
    return false;
  } finally {
    copies?.drop(passportId);
  }
  log.info({ passportId, deleted: old.length }, "unseal: old private copy cleared before the public pins");
  return true;
}

/**
 * The record GET /unseal and a resent POST /unseal may answer from after a record pin: the oldest
 * record under this passport's name, as every other reader picks it. Undefined when the lookup still
 * cannot tell, including a listing that does not show the record just pinned yet, or when the
 * oldest cannot be read back; then nothing is cached and GET asks Pinata itself.
 */
async function oldestRecord(
  passportId: Hex,
  mine: PinnedRecord,
  record: UnsealRecord,
  log: FastifyBaseLogger,
): Promise<{ record: UnsealRecord; pinned: PinnedRecord } | undefined> {
  const found = await findUnsealRecord(passportId);
  if (found.state !== "found") {
    log.warn({ passportId, state: found.state }, "unseal: could not confirm the oldest record, caching none");
    return undefined;
  }
  if (found.record.cid === mine.cid) {
    return { record, pinned: mine };
  }
  try {
    return { record: await readUnsealRecord(found.record.uri, passportId), pinned: found.record };
  } catch (error) {
    log.warn({ passportId, cid: found.record.cid, reason: reasonOf(error) }, "unseal: the oldest record could not be read, caching none");
    return undefined;
  }
}

/** The three files an unseal pins before its record, named as a partial answer names them. */
type Piece = "image" | "thumbnail" | "manifest";

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
 * name, a field that is not sent as plain text, or a passport id that is not 32 bytes of hex.
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
      } else {
        // The multipart plugin parses a part typed application/json, and skipping it would read as
        // a missing field. Refused in the words routes/shared.ts uses for the other routes (V57).
        throw new BadRequest(`field "${part.fieldname}" must be sent as plain text`);
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

/**
 * Whether a public pin failed because Pinata answered with a file it keeps on its private network,
 * which is what it does for bytes it already holds privately. It reads the network field Pinata's
 * answer filled, never the message, so rewording the message cannot change the answer.
 */
function heldPrivately(error: unknown): boolean {
  return error instanceof PinNotConfirmed && error.network === "private";
}
