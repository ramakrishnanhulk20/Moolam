import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { bearerToken } from "../auth/privy.js";
import type { RecheckItem, RecheckQueue } from "../recheck/queue.js";
import { privatelyRecheckable } from "../sealed.js";
import type { Hex, PassportRecord } from "../types.js";
import { PICTURE_SEALED_TTL_MS, pictureStateOf, type DocumentReader, type UnsealRecordFinder } from "../unseal.js";
import type { PrivateCopyStatus } from "./sealed.js";

export type { DocumentReader } from "../unseal.js";

/**
 * How long a "sealed" answer is held before the unseal record is looked for again. A holder can
 * publish the picture at any moment, so this is the longest a fresh unseal waits to be re-checked.
 * It is the verify answer's own limit for its picture fact, so the two never disagree for longer
 * than ten seconds.
 */
const SEALED_TTL_MS = PICTURE_SEALED_TTL_MS;

/** How many waiting requests one read of the queue hands over. The runner works through one page. */
const QUEUE_PAGE = 50;

/**
 * How long a status answer may be reused.
 *
 * A re-check takes minutes, so half a minute of staleness costs a waiting page nothing and keeps a
 * refresh loop off this service. Nothing in the answer belongs to the caller: a passport id and
 * what the runner did with it are as public as the chain.
 */
const STATUS_CACHE_SECONDS = 30;

const passportSchema = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{64}$/, "passportId must be 0x followed by 64 hex characters");

const requestSchema = z.object({ passportId: passportSchema });

const doneSchema = z.object({
  passportId: passportSchema,
  reportTx: z
    .string()
    .trim()
    .regex(/^0x[0-9a-fA-F]{64}$/, "reportTx must be 0x followed by 64 hex characters")
    .optional(),
  matched: z.boolean().optional(),
  distance: z.number().int().min(0).max(4096).optional(),
  // Taken long and cut to 200 by the queue rather than refused, so a runner pasting what went
  // wrong gets its request closed instead of a second failure to report.
  reason: z.string().trim().min(1).max(2000).optional(),
});

export interface RecheckRouteOptions {
  queue: RecheckQueue;
  /** The runner's bearer token. Undefined or empty switches the three runner routes off. */
  runnerToken?: string;
  readDocument?: DocumentReader;
  /** Finds the record a sealed passport was published under. Undefined reads every sealed passport as unknown. */
  findRecord?: UnsealRecordFinder;
  /** Whether a private copy is kept, the same answer /sealed/status gives. Undefined reads as unknown. */
  privateCopy?: PrivateCopyStatus;
}

/**
 * The re-check queue: anyone asks for a Chainlink second opinion, a runner elsewhere does the work.
 *
 * Nothing on these routes spends anything. A request is a line in a file, and the Chainlink run it
 * leads to happens on a machine of its own that decides for itself what it can afford. That is why
 * the public route needs no account: the cost of a stranger pressing the button is the runner's
 * time, bounded by the runner's own daily cap, and the queue's thousand-item ceiling.
 *
 * The three runner routes are behind one shared token rather than a user login. There is exactly
 * one runner and it is a machine, so a token in its environment is the whole identity that is
 * needed, and a host that has not set one answers 503 instead of guarding nothing.
 */
export async function recheckRoutes(app: FastifyInstance, options: RecheckRouteOptions): Promise<void> {
  const queue = options.queue;
  const token = options.runnerToken === undefined || options.runnerToken.length === 0 ? undefined : options.runnerToken;
  const sealed = sealedChecker(options.readDocument, options.findRecord);

  /**
   * POST /recheck/request: somebody asks for this passport to be re-checked.
   *
   * Ten a minute per address rather than the service's usual sixty. A request costs nothing to
   * make and nothing to serve, so the limit is not about this service's bill: it is what stops one
   * caller filling the queue with every passport on the registry faster than the runner drains it.
   */
  app.post(
    "/recheck/request",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = requestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "send a JSON body of { \"passportId\": \"0x...\" }, 64 hex characters" });
      }
      const passportId = parsed.data.passportId.toLowerCase() as Hex;

      const record = app.verifier.lookupExact(passportId);
      if (record === undefined) {
        request.log.warn({ ip: request.ip, passportId }, "rejected: /recheck/request unknown passport");
        return reply.code(404).send({ error: "no-passport", passportId });
      }

      const picture = await sealed(record);
      // B11: a sealed passport whose document asks for a private re-check is queued only while its
      // copy reads kept, or while nobody can tell and the runner checks again before it spends. A
      // copy that is gone, or a passport the chain does not hold, is refused like any sealed one.
      let refuseSealed = picture === "sealed";
      if (picture === "sealed-private") {
        const copy = options.privateCopy === undefined ? undefined : await options.privateCopy.statusOf(passportId);
        const state = copy === undefined ? "unknown" : copy.found ? copy.state : "gone";
        refuseSealed = state === "gone";
        request.log.info({ passportId, copy: state }, "recheck: sealed passport with a private copy");
      }
      if (refuseSealed) {
        request.log.warn({ ip: request.ip, passportId }, "rejected: /recheck/request sealed passport");
        return reply.code(409).send({
          error: "sealed",
          passportId,
          reason:
            "this passport's picture was never published, so there is nothing for the Chainlink verifier to fetch and re-check. Publish it first and then ask again.",
        });
      }

      const placed = queue.request(passportId);
      if (!placed.ok) {
        request.log.warn({ ip: request.ip, passportId }, "rejected: /recheck/request queue full");
        return reply.code(503).send({
          error: "queue-full",
          reason: "the re-check queue is full of requests nobody has run yet. Try again later.",
        });
      }

      if (!placed.already) {
        request.log.info({ passportId, position: placed.position }, "recheck: requested");
      }
      return reply.send({
        passportId,
        status: placed.item.status,
        requestedAt: placed.item.requestedAt,
        position: placed.position,
        already: placed.already,
      });
    },
  );

  /** GET /recheck/status/:passportId: where a request got to, or that nobody has asked. */
  app.get("/recheck/status/:passportId", async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = passportSchema.safeParse((request.params as { passportId?: string }).passportId);
    if (!parsed.success) {
      return reply.code(400).send({ error: "passportId must be 0x followed by 64 hex characters" });
    }
    const passportId = parsed.data.toLowerCase() as Hex;
    reply.header("cache-control", `public, max-age=${STATUS_CACHE_SECONDS}`);

    const held = queue.status(passportId);
    if (held === undefined) {
      return reply.send({ passportId, status: "none" });
    }
    return reply.send(statusOut(held));
  });

  /** GET /recheck/queue: what the runner should pick up. Reading it claims nothing. */
  app.get("/recheck/queue", async (request: FastifyRequest, reply: FastifyReply) => {
    const refusal = runnerRefusal(request, reply, token);
    if (refusal !== undefined) {
      return refusal;
    }
    const counts = queue.counts();
    return reply.send({
      items: queue.pending(QUEUE_PAGE).map((item) => ({
        passportId: item.passportId,
        requestedAt: item.requestedAt,
        requestedBy: item.requestedBy,
      })),
      pending: counts.pending,
      running: counts.running,
    });
  });

  /** POST /recheck/claim: the runner takes one request, so a second runner leaves it alone. */
  app.post("/recheck/claim", async (request: FastifyRequest, reply: FastifyReply) => {
    const refusal = runnerRefusal(request, reply, token);
    if (refusal !== undefined) {
      return refusal;
    }
    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "send a JSON body of { \"passportId\": \"0x...\" }, 64 hex characters" });
    }
    const passportId = parsed.data.passportId.toLowerCase() as Hex;

    const claimed = queue.claim(passportId);
    if (!claimed.ok) {
      const status = claimed.refused === "no-request" ? 404 : 409;
      request.log.warn({ passportId, reason: claimed.refused }, "rejected: /recheck/claim");
      return reply.code(status).send({ error: claimed.refused, passportId });
    }

    request.log.info({ passportId, reclaimed: claimed.reclaimed }, "recheck: claimed");
    return reply.send({ ...statusOut(claimed.item), reclaimed: claimed.reclaimed });
  });

  /** POST /recheck/done: the runner says what happened. A report transaction is what makes it done. */
  app.post("/recheck/done", async (request: FastifyRequest, reply: FastifyReply) => {
    const refusal = runnerRefusal(request, reply, token);
    if (refusal !== undefined) {
      return refusal;
    }
    const parsed = doneSchema.safeParse(request.body);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((issue) => issue.message).join("; ");
      return reply.code(400).send({ error: `this is not a report this service can record: ${detail}` });
    }
    const passportId = parsed.data.passportId.toLowerCase() as Hex;

    const finished = queue.finish(passportId, {
      reportTx: parsed.data.reportTx,
      matched: parsed.data.matched,
      distance: parsed.data.distance,
      reason: parsed.data.reason,
    });
    if (!finished.ok) {
      const status = finished.refused === "no-request" ? 404 : 409;
      request.log.warn({ passportId, reason: finished.refused }, "rejected: /recheck/done");
      return reply.code(status).send({ error: finished.refused, passportId });
    }

    request.log.info(
      { passportId, status: finished.item.status, reportTx: finished.item.reportTx },
      "recheck: finished",
    );
    return reply.send(statusOut(finished.item));
  });
}

/** The answer shape all three readable routes share. Undefined fields are left out by the encoder. */
function statusOut(item: RecheckItem): Record<string, unknown> {
  return {
    passportId: item.passportId,
    status: item.status,
    requestedAt: item.requestedAt,
    startedAt: item.startedAt,
    finishedAt: item.finishedAt,
    reportTx: item.reportTx,
    matched: item.matched,
    distance: item.distance,
    reason: item.reason,
  };
}

/**
 * The refusal a runner route owes this caller, or undefined when it may go on.
 *
 * A host with no token set says so with a 503 rather than a 401: the route is not guarding
 * anything on this host, and a runner pointed at the wrong service should learn that from the
 * answer instead of trying tokens. The comparison takes the same time whatever the token is, so a
 * caller cannot find the right one a character at a time.
 */
function runnerRefusal(request: FastifyRequest, reply: FastifyReply, token: string | undefined): FastifyReply | undefined {
  if (token === undefined) {
    return reply.code(503).send({
      error: "runner-disabled",
      reason: "this host has no RUNNER_TOKEN set, so it has no re-check runner.",
    });
  }
  const given = bearerToken(request.headers.authorization);
  if (given === undefined || !sameToken(given, token)) {
    request.log.warn({ ip: request.ip, url: request.url }, "rejected: /recheck runner unauthorized");
    return reply.code(401).send({ error: "unauthorized" });
  }
  return undefined;
}

/** Compares two tokens in the same time whatever they hold. Shared with /sealed/link. */
export function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** "sealed-private" is a sealed document that passes the one privately re-checkable predicate (B7). */
type SealedAnswer = "sealed" | "sealed-private" | "public" | "unsealed" | "unknown";

/**
 * Whether this passport's picture is out where the Chainlink verifier can fetch it.
 *
 * The index records carry no sealed flag, so the answer starts from the metadata document the
 * passport points at, and for a document that says sealed, from the record its holder pins on
 * unsealing. The document is written once, so "public" can never go stale, and a record is never
 * taken back, so neither can "unsealed": both are remembered for the life of the process. "sealed"
 * is the one answer that changes, the moment the holder publishes, so it is held for ten seconds at
 * most and then asked again. A caller cannot turn this route into a gateway read per request: a
 * repeat inside those ten seconds is answered from memory, and only passports the index already
 * knows ever get this far.
 *
 * A read that fails answers "unknown" and is not remembered, and an unknown request is queued. A
 * sealed passport slipping through costs the runner one refusal; a gateway or Pinata being slow
 * must never cost a real picture its second opinion.
 *
 * A sealed document that also passes the privately re-checkable predicate answers "sealed-private"
 * and is held the same ten seconds, and whether its copy is still kept is the route's next question.
 */
function sealedChecker(
  read: DocumentReader | undefined,
  findRecord: UnsealRecordFinder | undefined,
): (record: PassportRecord) => Promise<SealedAnswer> {
  const known = new Map<Hex, { state: Exclude<SealedAnswer, "unknown">; until: number }>();
  const inFlight = new Map<Hex, Promise<SealedAnswer>>();
  const finder: UnsealRecordFinder =
    findRecord ??
    (async () => {
      throw new Error("this host has no unseal record finder");
    });

  return async (record) => {
    if (read === undefined) {
      return "unknown";
    }
    const settled = known.get(record.id);
    if (settled !== undefined) {
      if (settled.until > Date.now()) {
        return settled.state;
      }
      known.delete(record.id);
    }
    const running = inFlight.get(record.id);
    if (running !== undefined) {
      return await running;
    }

    const task = (async (): Promise<SealedAnswer> => {
      try {
        // The document pictureStateOf reads is kept here, so the private re-check predicate runs on
        // the very bytes that said sealed rather than on a second read that could differ.
        let document: unknown;
        const keeping: DocumentReader = async (uri) => {
          document = await read(uri);
          return document;
        };
        const reading = await pictureStateOf(record, keeping, finder);
        if (reading.state === "unreadable") {
          return "unknown";
        }
        const state: Exclude<SealedAnswer, "unknown"> =
          reading.state === "sealed" && privatelyRecheckable(document) ? "sealed-private" : reading.state;
        const until = reading.state === "sealed" ? Date.now() + SEALED_TTL_MS : Number.POSITIVE_INFINITY;
        known.set(record.id, { state, until });
        return state;
      } finally {
        inFlight.delete(record.id);
      }
    })();
    inFlight.set(record.id, task);
    return await task;
  };
}
