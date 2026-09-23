import { APIError } from "@privy-io/node";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { InvalidToken, bearerToken, verifyPrivyToken, type PrivyIdentity, type PrivyKeys } from "../auth/privy.js";
import { embeddedWallets } from "../auth/wallet.js";
import { env } from "../env.js";
import { privy, privyErrorText } from "../generate/privy.js";
import {
  PINATA_GATEWAY,
  deletePrivateFile,
  findPrivateByName,
  privateDownloadLink,
  type PrivateListing,
} from "../ipfs/pinata.js";
import { takeToday } from "../limits/dayGate.js";
import type { RecheckQueue } from "../recheck/queue.js";
import { readClient } from "../reputation/registry.js";
import { privateRecheckFor, privateThumbnailName } from "../sealed.js";
import type { Hex } from "../types.js";
import { holderOf, readMetadataDocument, readPassport, type OnChainPassport } from "../unseal.js";
import { sameToken } from "./recheck.js";

/** How long a kept or gone answer is held, and how long a cache in front of this service may keep it. */
export const COPY_STATUS_TTL_MS = 60_000;

/** How many passports the status memory holds at once before it forgets the oldest. */
const COPY_STATUS_MAX_ENTRIES = 2_000;

/**
 * How long a read link lives. Fixed here and never taken from a request (B15): long enough for the
 * workflow to open it once, and well inside the Pinata client's own cap.
 */
export const LINK_SECONDS = 120;

/**
 * How recently the runner must have claimed a passport for a link to be minted (ruling D3). The
 * runner gives a simulation ten minutes, so a claim older than that is a run that is over, and a
 * stolen token reads only what is being run right now rather than the whole store.
 */
export const LINK_CLAIM_WINDOW_MS = 10 * 60 * 1000;

/** Links one passport may be given in an hour (B15). A run needs one; five covers its retries. */
export const LINKS_PER_PASSPORT_PER_HOUR = 5;

/** Links the whole service may mint in a UTC day (B15), shown in /health beside the other ceilings. */
export const SEALED_LINKS_PER_DAY = 100;

const HOUR_MS = 60 * 60 * 1000;

/** How many passports the hourly counter remembers before it sweeps out the ones with no recent link. */
const HOURLY_SWEEP_AT = 1_000;

const passportSchema = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{64}$/, "passportId must be 0x followed by 64 hex characters");

const PASSPORT_ID = /^0x[0-9a-f]{64}$/;

const requestSchema = z.object({ passportId: passportSchema });

/** The delete answer: the passport and a count, never a file id. */
const forgetAnswerSchema = z.strictObject({
  passportId: z.string().regex(PASSPORT_ID),
  deleted: z.number().int().nonnegative(),
});

/** The link answer, checked on the way out: nothing but the URL and when it stops working. */
const linkAnswerSchema = z.strictObject({
  url: z.url({ protocol: /^https$/ }),
  expiresAt: z.iso.datetime(),
});

/** The status answer, checked on the way out like an input to whoever reads it (standard 3). */
const statusAnswerSchema = z.strictObject({
  passportId: z.string().regex(PASSPORT_ID),
  state: z.enum(["kept", "gone", "unknown"]),
  privateRecheck: z.boolean(),
});

export type CopyState = "kept" | "gone" | "unknown";

/**
 * What this service knows about one passport's private copy.
 *
 * `found: false` is the chain saying it holds no such passport. `reason` rides along on an unknown
 * answer for the log and is never sent to a caller.
 */
export type CopyStatus =
  | { found: false }
  | { found: true; state: CopyState; privateRecheck: boolean; reason?: string };

export interface PrivateCopyStatus {
  /** Never rejects. Every read that fails comes back as unknown and is not remembered. */
  statusOf: (passportId: Hex) => Promise<CopyStatus>;
  /** Forgets what is held for this passport, so the next read goes back to Pinata. */
  drop: (passportId: Hex) => void;
}

/**
 * Whether a passport's private copy is kept, gone, or cannot be told (B10), with a short memory.
 *
 * The id comes from the caller, lower-cased once, and the chain has to hold the passport before
 * anything else is read. A document that does not ask for a private re-check of exactly this
 * passport answers gone with privateRecheck false and never reaches Pinata. For one that does, the
 * lookup lists the exact name and filters it again here: one file is kept, none is gone, and two or
 * more is unknown, because "exactly one" is the only state a link may be minted from and two files
 * under one name is not a state this service ever writes.
 *
 * Kept and gone are held for a minute; unknown, a chain that did not answer and a passport the
 * chain does not hold are never held. Two readers asking at once share one read. `drop` also
 * stops a read already in flight from being remembered, so a lookup that listed the file a moment
 * before the holder deleted it cannot put "kept" back into memory afterwards.
 */
export function privateCopyStatus(
  options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {},
): PrivateCopyStatus {
  const ttlMs = options.ttlMs ?? COPY_STATUS_TTL_MS;
  const maxEntries = options.maxEntries ?? COPY_STATUS_MAX_ENTRIES;
  const now = options.now ?? ((): number => Date.now());
  const chain = readClient();
  const registry = env.MOOLAM_REGISTRY_ADDRESS as Hex;
  const held = new Map<Hex, { status: CopyStatus; until: number }>();
  const inFlight = new Map<Hex, Promise<CopyStatus>>();
  let epoch = 0;

  const remember = (id: Hex, status: CopyStatus): void => {
    held.delete(id);
    while (held.size >= maxEntries) {
      const oldest = held.keys().next();
      if (oldest.done === true) {
        break;
      }
      held.delete(oldest.value);
    }
    held.set(id, { status, until: now() + ttlMs });
  };

  const read = async (id: Hex): Promise<{ status: CopyStatus; hold: boolean }> => {
    let metadataURI: string;
    try {
      const passport = await readPassport(chain, registry, id);
      if (passport === undefined) {
        return { status: { found: false }, hold: false };
      }
      metadataURI = passport.metadataURI;
    } catch (error) {
      return { status: unknown(false, `the chain did not answer: ${reasonOf(error)}`), hold: false };
    }

    let document: unknown;
    try {
      document = await readMetadataDocument(metadataURI);
    } catch (error) {
      return { status: unknown(false, `the metadata document could not be read: ${reasonOf(error)}`), hold: false };
    }
    if (privateRecheckFor(document, id) !== "asked") {
      return { status: { found: true, state: "gone", privateRecheck: false }, hold: true };
    }

    let files: PrivateListing[];
    try {
      files = await sameName(id);
    } catch (error) {
      return { status: unknown(true, `the private listing could not answer: ${reasonOf(error)}`), hold: false };
    }
    if (files.length === 1) {
      return { status: { found: true, state: "kept", privateRecheck: true }, hold: true };
    }
    if (files.length === 0) {
      return { status: { found: true, state: "gone", privateRecheck: true }, hold: true };
    }
    return { status: unknown(true, `${files.length} private files share this passport's name`), hold: false };
  };

  return {
    statusOf: async (passportId) => {
      const id = passportId.toLowerCase() as Hex;
      const memory = held.get(id);
      if (memory !== undefined) {
        if (memory.until > now()) {
          return memory.status;
        }
        held.delete(id);
      }
      const running = inFlight.get(id);
      if (running !== undefined) {
        return await running;
      }

      const startedIn = epoch;
      const task: Promise<CopyStatus> = read(id)
        .then(({ status, hold }) => {
          if (hold && startedIn === epoch) {
            remember(id, status);
          }
          return status;
        })
        .finally(() => {
          if (inFlight.get(id) === task) {
            inFlight.delete(id);
          }
        });
      inFlight.set(id, task);
      return await task;
    },

    drop: (passportId) => {
      const id = passportId.toLowerCase() as Hex;
      held.delete(id);
      inFlight.delete(id);
      epoch += 1;
    },
  };
}

export interface SealedRouteOptions {
  copies: PrivateCopyStatus;
  queue: RecheckQueue;
  /** The workflow's bearer token for /sealed/link. Undefined or empty answers 503 not-configured. */
  linkToken?: string;
  /** Keys to check Privy tokens against, for tests. Undefined uses the app's published key set. */
  keys?: PrivyKeys;
}

/**
 * The routes that touch a sealed passport's private copy.
 *
 * GET /sealed/status/:passportId is public and needs no token: it says kept, gone or unknown, and
 * whether the passport's document asked for a private re-check at all. POST /sealed/link hands the
 * confidential workflow a two minute read link, behind SEALED_LINK_TOKEN and a claim in the re-check
 * queue. POST /sealed/forget is the holder deleting the copy. No answer on any of the three names
 * the file's id or content id, and only a successful link carries a URL.
 */
export async function sealedRoutes(app: FastifyInstance, options: SealedRouteOptions): Promise<void> {
  const copies = options.copies;
  const queue = options.queue;
  const linkToken = options.linkToken === undefined || options.linkToken.length === 0 ? undefined : options.linkToken;
  const chain = readClient();
  const registry = env.MOOLAM_REGISTRY_ADDRESS as Hex;
  const hourly = perPassportHour(LINKS_PER_PASSPORT_PER_HOUR);

  /**
   * POST /sealed/link: a read link to one passport's private copy, for the confidential workflow.
   *
   * Every check below must hold, in this order, and each refusal carries no URL and no file id
   * (B4): the token, compared in constant time; the id, 32 bytes of hex lower-cased once; the
   * registry holding the passport, where a read that failed is 503 and never a guess; its document,
   * read through the guarded fetch, privately re-checkable and committing to this very id (B1); a
   * runner holding the passport's request, claimed less than ten minutes ago (D3); and exactly one
   * file under the passport's name (B3). Only then are the hourly and daily caps taken (B15) and
   * the link minted, for a fixed 120 seconds, and parsed again before it is sent: https, on the
   * configured dedicated gateway's host (standard 3).
   *
   * The URL is a bearer secret until it expires, so no log line here carries it or the token, and a
   * failure to mint logs the error's name only (B5).
   */
  app.post("/sealed/link", async (request: FastifyRequest, reply: FastifyReply) => {
    if (linkToken === undefined) {
      return reply.code(503).send({
        error: "not-configured",
        reason: "this host has no SEALED_LINK_TOKEN set, so it mints no private links.",
      });
    }
    const given = bearerToken(request.headers.authorization);
    if (given === undefined || !sameToken(given, linkToken)) {
      request.log.warn({ ip: request.ip }, "rejected: /sealed/link unauthorized");
      return reply.code(401).send({ error: "unauthorized" });
    }

    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'send a JSON body of { "passportId": "0x..." }, 64 hex characters' });
    }
    const passportId = parsed.data.passportId.toLowerCase() as Hex;
    const refuse = (status: number, error: string, reason?: string): FastifyReply => {
      request.log.warn({ passportId, error, reason }, "rejected: /sealed/link");
      return reply.code(status).send({ error, passportId });
    };

    let passport: OnChainPassport | undefined;
    try {
      passport = await readPassport(chain, registry, passportId);
    } catch (error) {
      return refuse(503, "chain-unavailable", reasonOf(error));
    }
    if (passport === undefined) {
      return refuse(404, "no-passport");
    }

    let document: unknown;
    try {
      document = await readMetadataDocument(passport.metadataURI);
    } catch (error) {
      return refuse(503, "metadata-unavailable", reasonOf(error));
    }
    const asked = privateRecheckFor(document, passportId);
    if (asked === "not-asked") {
      return refuse(404, "nothing-kept");
    }
    if (asked === "other-passport") {
      return refuse(409, "commitment-mismatch");
    }

    if (!queue.claimedWithin(passportId, LINK_CLAIM_WINDOW_MS)) {
      return refuse(409, "not-claimed");
    }

    let files: PrivateListing[];
    try {
      files = await sameName(passportId);
    } catch (error) {
      return refuse(503, "lookup-unavailable", reasonOf(error));
    }
    if (files.length === 0) {
      return refuse(404, "gone");
    }
    if (files.length > 1) {
      return refuse(409, "ambiguous", `${files.length} private files share this passport's name`);
    }
    const file = files[0] as PrivateListing;

    const slot = hourly.take(passportId);
    if (slot === undefined) {
      return refuse(429, "link-cap", `more than ${LINKS_PER_PASSPORT_PER_HOUR} links for one passport in an hour`);
    }
    const today = takeToday(app, request, reply, "links", slot.giveBack);
    if (!today.ok) {
      return today.refused;
    }

    // From here both slots stay spent whatever happens: a mint that timed out may still have signed
    // a link, and the caps bound links that may exist, not links that were delivered.
    const expiresAt = new Date(Date.now() + LINK_SECONDS * 1000).toISOString();
    let url: string;
    try {
      url = await privateDownloadLink(file.cid, LINK_SECONDS);
    } catch (error) {
      return refuse(502, "link-unavailable", error instanceof Error ? error.name : "unknown");
    }
    if (!onDedicatedGateway(url)) {
      return refuse(502, "link-unavailable", "the link was not https on the configured gateway");
    }

    request.log.info({ passportId }, "sealed: private link minted");
    return reply.send(linkAnswerSchema.parse({ url, expiresAt }));
  });

  /**
   * POST /sealed/forget: the holder deletes Moolam's private copy of their passport (B9).
   *
   * The caller's Privy token names a user, the Privy user record names their wallets, and `ownerOf`
   * on the registry, read at this moment, has to be one of them: the unseal route's pattern, so a
   * wallet never comes from the body and never from an index. Then every private file whose name is
   * exactly this passport's is deleted, two included, because two files under one name are both
   * copies of this passport's thumbnail. A listing that could not finish deletes nothing and answers
   * 503: deletion happens only on a definite answer.
   *
   * The status memory for the passport is dropped whatever happened after the listing, so neither
   * /sealed/status nor the queue goes on saying "kept" for a copy that is gone. The answer is the
   * count and never a file id, and the log line carries the count the same way.
   */
  app.post("/sealed/forget", async (request: FastifyRequest, reply: FastifyReply) => {
    const identity = await identify(request, options.keys);
    if (identity === undefined) {
      request.log.warn({ ip: request.ip }, "rejected: /sealed/forget unauthorized");
      return reply.code(401).send({ error: "unauthorized" });
    }

    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'send a JSON body of { "passportId": "0x..." }, 64 hex characters' });
    }
    const passportId = parsed.data.passportId.toLowerCase() as Hex;
    const refuse = (status: number, error: string, reason?: string): FastifyReply => {
      request.log.warn({ passportId, user: identity.userId, error, reason }, "rejected: /sealed/forget");
      return reply.code(status).send({ error, passportId });
    };

    let passport: OnChainPassport | undefined;
    try {
      passport = await readPassport(chain, registry, passportId);
    } catch (error) {
      return refuse(503, "chain-unavailable", reasonOf(error));
    }
    if (passport === undefined) {
      return refuse(404, "no-passport");
    }

    let wallets: Hex[];
    try {
      wallets = await embeddedWallets(privy(), identity.userId);
    } catch (error) {
      if (error instanceof APIError && error.status === 404) {
        return refuse(403, "not-holder", "Privy does not know this user");
      }
      return refuse(502, "privy-unavailable", privyErrorText(error));
    }
    let holder: Hex;
    try {
      holder = await holderOf(chain, registry, passportId);
    } catch (error) {
      return refuse(503, "chain-unavailable", reasonOf(error));
    }
    if (!wallets.includes(holder)) {
      return refuse(403, "not-holder");
    }

    let document: unknown;
    try {
      document = await readMetadataDocument(passport.metadataURI);
    } catch (error) {
      return refuse(503, "metadata-unavailable", reasonOf(error));
    }
    if (privateRecheckFor(document, passportId) !== "asked") {
      return refuse(404, "nothing-kept");
    }

    let files: PrivateListing[];
    try {
      files = await sameName(passportId);
    } catch (error) {
      return refuse(503, "lookup-unavailable", reasonOf(error));
    }

    // Bounded by the listing itself, which pages at most five pages before it refuses to answer.
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
    copies.drop(passportId);

    if (failed > 0) {
      request.log.error(
        { passportId, user: identity.userId, deleted, failed },
        "sealed: the private copy was only partly deleted",
      );
      return reply.code(502).send({ error: "delete-failed", passportId, deleted });
    }
    request.log.info({ passportId, user: identity.userId, deleted }, "sealed: private copy forgotten");
    return reply.send(forgetAnswerSchema.parse({ passportId, deleted }));
  });

  /**
   * GET /sealed/status/:passportId: whether the private copy is kept, gone, or cannot be told.
   *
   * Thirty a minute per address, below the service's sixty, because a miss costs a chain read, a
   * gateway read and a Pinata listing out of the account's shared minute (B10). Kept and gone may
   * be cached for a minute; unknown and every refusal may not, because unknown is the answer that
   * must be asked again rather than remembered.
   */
  app.get(
    "/sealed/status/:passportId",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      reply.header("cache-control", "no-store");
      const parsed = passportSchema.safeParse((request.params as { passportId?: string }).passportId);
      if (!parsed.success) {
        return reply.code(400).send({ error: "passportId must be 0x followed by 64 hex characters" });
      }
      const passportId = parsed.data.toLowerCase() as Hex;

      const status = await copies.statusOf(passportId);
      if (!status.found) {
        return reply.code(404).send({ error: "no-passport", passportId });
      }
      if (status.state === "unknown") {
        request.log.warn({ passportId, reason: status.reason }, "/sealed/status: could not tell whether the copy is kept");
      } else {
        reply.header("cache-control", `public, max-age=${COPY_STATUS_TTL_MS / 1000}`);
      }
      return reply.send(
        statusAnswerSchema.parse({ passportId, state: status.state, privateRecheck: status.privateRecheck }),
      );
    },
  );
}

/**
 * Every private file under this passport's name, filtered on the whole name here as well as inside
 * the Pinata client (B3), so a change to either can never turn a prefix match into a file of ours.
 */
async function sameName(passportId: Hex): Promise<PrivateListing[]> {
  const name = privateThumbnailName(passportId);
  return (await findPrivateByName(name)).filter((file) => file.name === name);
}

/**
 * Whether a link is https on the host PINATA_GATEWAY_URL names, parsed again here rather than
 * trusted from the client that fetched it. One URL parse and one host equality, no list.
 */
function onDedicatedGateway(url: string): boolean {
  try {
    const link = new URL(url);
    return link.protocol === "https:" && link.host === new URL(PINATA_GATEWAY).host;
  } catch {
    return false;
  }
}

/**
 * Links per passport in a sliding hour. Only passports that passed every check before the caps
 * reach it, which means a claimed request with a kept copy, and once it holds more than
 * HOURLY_SWEEP_AT passports it drops the ones with no link inside the hour.
 */
function perPassportHour(
  max: number,
  now: () => number = () => Date.now(),
): { take: (passportId: Hex) => { giveBack: () => void } | undefined } {
  const taken = new Map<Hex, number[]>();
  return {
    take: (passportId) => {
      const cutoff = now() - HOUR_MS;
      if (taken.size > HOURLY_SWEEP_AT) {
        for (const [id, times] of taken) {
          if (times.every((at) => at <= cutoff)) {
            taken.delete(id);
          }
        }
      }
      const recent = (taken.get(passportId) ?? []).filter((at) => at > cutoff);
      if (recent.length >= max) {
        taken.set(passportId, recent);
        return undefined;
      }
      const at = now();
      recent.push(at);
      taken.set(passportId, recent);
      let held = true;
      return {
        giveBack: () => {
          if (!held) return;
          held = false;
          const times = taken.get(passportId) ?? [];
          const index = times.indexOf(at);
          if (index !== -1) times.splice(index, 1);
        },
      };
    },
  };
}

/**
 * Who sent this request, or undefined when the Privy token is missing, expired or from another app.
 * The unseal route's check, repeated rather than shared because that route is not this order's to
 * change. Anything wrong with the token is a 401 and never a 500.
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

function unknown(privateRecheck: boolean, reason: string): CopyStatus {
  return { found: true, state: "unknown", privateRecheck, reason };
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
