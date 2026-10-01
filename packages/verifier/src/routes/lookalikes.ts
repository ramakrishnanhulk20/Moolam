import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { isPassportId } from "../consentRead.js";
import { MAX_UNIX_SECONDS, passportKey } from "../mcp/inputs.js";
import { MAX_BACKLOG, backlogOf, inLookalikeOrder, type BacklogView } from "../lookalike/backlog.js";
import { lookalikesOf } from "../lookalike/search.js";
import type { Hex } from "../types.js";

/** The most candidates one answer names, the workflow's own read budget per run (L9). */
export const MAX_CANDIDATES = 3;

/** The most fingerprint pairs one question carries: a picture's eight turns and mirrors. */
export const MAX_PAIRS = 8;

/**
 * How far past this host's clock an `asOf` may be, so a node whose clock runs a little fast is
 * still answered while a time far in the future, which no index can be loaded through, is refused.
 */
export const AS_OF_SKEW_S = 60;

/**
 * What every caller together may ask of each route in a minute, on top of the service's 60 a
 * minute per address (R13, L18). A Chainlink run asks the candidates route once per node, so 600
 * is dozens of runs a minute; the backlog is asked once per node every ten minutes.
 */
export const ROUTE_CEILINGS = { candidates: 600, backlog: 120 } as const;

export const WINDOW_MS = 60_000;

const pairSchema = z.strictObject({
  phash: z.string().regex(/^0x[0-9a-fA-F]{16}$/, "phash must be 0x followed by 16 hex characters"),
  blockhash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "blockhash must be 0x followed by 64 hex characters"),
});

const unixSeconds = z.number().int().min(1).max(MAX_UNIX_SECONDS);

const candidatesSchema = z.strictObject({
  fingerprints: z.array(pairSchema).min(1).max(MAX_PAIRS),
  asOf: unixSeconds,
});

const backlogSchema = z.strictObject({
  asOf: z.string().regex(/^[1-9][0-9]{0,9}$/, "asOf must be a whole number of unix seconds"),
  n: z.string().regex(new RegExp(`^[1-${MAX_BACKLOG}]$`), `n must be a whole number from 1 to ${MAX_BACKLOG}`),
});

export interface LookalikeRouteOptions {
  /** What the backlog reads besides the index, as the last background refresh left it. */
  view: () => BacklogView;
  /** Replaces the two ceilings, for tests. */
  ceilings?: { candidates?: number; backlog?: number };
  /** Replaces the clock `asOf` and the ceilings are read on, for tests. */
  clock?: () => number;
}

/**
 * A count of every caller's requests to one route in the current minute. Kept in this process's
 * memory: two hosts would each allow the full ceiling, which DEPLOY.md's one host never meets.
 */
export function ceiling(max: number, clock: () => number): () => boolean {
  let windowStart = 0;
  let used = 0;
  return () => {
    const now = clock();
    if (now - windowStart >= WINDOW_MS) {
      windowStart = now;
      used = 0;
    }
    if (used >= max) return false;
    used += 1;
    return true;
  };
}

/**
 * The two routes Chainlink's nodes ask during a look-alike run. Both answer from the in-memory
 * index and what the background refresh left beside it: neither reads the chain, Pinata or the
 * gateway while a request waits (L16, L18). Both are pure functions of that copy and the inputs,
 * so every node asking with the same `asOf` while one copy is in hand gets the same bytes back.
 * Neither ever decides anything: the workflow proves every id on chain before it writes (L8).
 *
 * Every request is shape-checked before any scan and refused 400 when malformed. Both routes sit
 * under the service's 60 a minute per address and a ceiling of their own for everyone, which
 * answers 429 `route-limit`.
 */
export async function lookalikeRoutes(app: FastifyInstance, options: LookalikeRouteOptions): Promise<void> {
  const clock = options.clock ?? Date.now;
  const limits = {
    candidates: options.ceilings?.candidates ?? ROUTE_CEILINGS.candidates,
    backlog: options.ceilings?.backlog ?? ROUTE_CEILINGS.backlog,
  };
  const candidatesRoom = ceiling(limits.candidates, clock);
  const backlogRoom = ceiling(limits.backlog, clock);
  const nowSeconds = (): number => Math.floor(clock() / 1000);

  const refuse = (request: FastifyRequest, reply: FastifyReply, status: number, error: string): FastifyReply => {
    request.log.warn({ ip: request.ip, url: request.url, status, reason: error }, "rejected: look-alike route");
    return reply.code(status).header("cache-control", "no-store").send({ error });
  };
  const overCeiling = (request: FastifyRequest, reply: FastifyReply): FastifyReply =>
    refuse(request, reply.header("retry-after", String(WINDOW_MS / 1000)), 429, "route-limit");

  /**
   * POST /lookalikes/candidates: up to three earlier passports that might show the same picture as
   * any of the fingerprint pairs sent, registered strictly before `asOf`, oldest first by the
   * shared rule. The earliest registration within the thresholds is always among them.
   */
  app.post("/lookalikes/candidates", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!candidatesRoom()) return overCeiling(request, reply);
    const parsed = candidatesSchema.safeParse(request.body);
    if (!parsed.success) {
      return refuse(request, reply, 400, `send {"fingerprints":[{"phash":"0x...","blockhash":"0x..."}],"asOf":<unix seconds>} with 1 to ${MAX_PAIRS} pairs`);
    }
    const { fingerprints, asOf } = parsed.data;
    if (asOf > nowSeconds() + AS_OF_SKEW_S) {
      return refuse(request, reply, 400, "asOf is in the future");
    }

    const copy = app.verifier.snapshot();
    if (copy.state().stale || !copy.covers(asOf)) {
      return reply.header("cache-control", "no-store").send({ status: "not-ready" });
    }
    const pairs = fingerprints.map((pair) => ({ phash: BigInt(pair.phash), blockhash: pair.blockhash.toLowerCase() as Hex }));
    const candidates = lookalikesOf(copy.index, pairs, asOf)
      .map((entry) => entry.id)
      .filter(isPassportId)
      .map(passportKey)
      .slice(0, MAX_CANDIDATES);
    return reply.header("cache-control", "no-store").send({ status: "ok", candidates });
  });

  /**
   * GET /lookalikes/backlog?asOf=&n=: up to n passports registered before `asOf` that still lack a
   * network verdict or, for an original, a look-alike record, and that the workflow can check.
   */
  app.get("/lookalikes/backlog", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!backlogRoom()) return overCeiling(request, reply);
    const parsed = backlogSchema.safeParse(request.query);
    if (!parsed.success) {
      return refuse(request, reply, 400, `send ?asOf=<unix seconds>&n=<1 to ${MAX_BACKLOG}>`);
    }
    const asOf = Number(parsed.data.asOf);
    const n = Number(parsed.data.n);
    if (asOf > nowSeconds() + AS_OF_SKEW_S) {
      return refuse(request, reply, 400, "asOf is in the future");
    }

    const copy = app.verifier.snapshot();
    if (copy.state().stale || !copy.covers(asOf)) {
      return reply.header("cache-control", "no-store").send({ status: "not-ready" });
    }
    return reply.header("cache-control", "no-store").send(backlogOf(inLookalikeOrder(copy.passports), asOf, n, options.view()));
  });
}
