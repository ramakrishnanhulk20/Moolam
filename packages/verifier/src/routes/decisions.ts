import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Address, Hex } from "viem";
import { z } from "zod";
import {
  DISPUTE_REJECTED,
  DISPUTE_UPHELD,
  liveDecisionChain,
  offlineDecisionChain,
  type DecisionChain,
} from "../challenges/decisionChain.js";
import {
  fitsDecisions,
  reasonsDigest,
  reasonsDocument,
  reasonsHashOf,
  reasonsTextProblem,
  type ReasonsDocument,
} from "../challenges/reasons.js";
import { ReasonsStore, ReasonsStoreClosed, reasonsKey } from "../challenges/reasonsStore.js";
import { env } from "../env.js";
import { PinRefused, pinJson } from "../ipfs/pinata.js";
import { dayLimitRefusal, fileDayStore, globalDay, memoryDayStore } from "../limits/globalDay.js";
import { passportKey } from "../mcp/inputs.js";
import { safeReason } from "../net/errorText.js";
import { recoverLikeRegistry } from "../platform/signatures.js";
import { STATE_FILES, stateFile } from "../stateDir.js";

/**
 * How many reasons documents this route pins a day, for everyone. Only the resolver gets past the
 * signature check and a dispute costs its challenger a 1 MON bond, so a few a day is the honest rate;
 * the ceiling bounds what a stolen resolver key can spend on Pinata. A repeat of reasons already
 * pinned takes no slot.
 */
export const REASONS_PER_DAY = 20;

/**
 * A body this route reads at most. Reasons of 8,000 bytes written as JSON escapes can take six
 * characters a byte; anything past this is not a reasons body.
 */
const REASONS_BODY_LIMIT = 64 * 1024;

/**
 * How long after any resolver() read, answered or failed, the gate starts no other. A flood of
 * strangers costs at most one read a minute even while the chain is down; a new resolver waits at
 * most this long to pass, and the old one is still stopped by the one-block check in the meantime.
 */
export const RESOLVER_REFRESH_MS = 60_000;

/** Says whether a recovered signer is the resolver; throws when the resolver cannot be read. */
export type ResolverGate = (signer: Address) => Promise<boolean>;

/**
 * A filter in front of the route's chain read, so a signature that is not the resolver's costs no
 * decisionAt. It holds the last resolver read and when the last read was tried; a signer equal to the
 * held resolver passes with no read. Any other signer causes a read only once RESOLVER_REFRESH_MS has
 * passed since the last attempt, and every caller arriving meanwhile shares the one read in flight.
 * Inside that window a stranger is refused (false) when the last attempt answered, and gets the
 * attempt's error when it failed, so a failure is never read as a pass or a plain refusal. Passing
 * here proves nothing on its own: the route still checks the signer against the resolver decisionAt
 * reads at one block.
 */
export function resolverGate(readResolver: () => Promise<Hex>, clock: () => number): ResolverGate {
  let held: Address | undefined;
  let triedAt: number | undefined;
  let failure: { error: unknown } | undefined;
  let reading: Promise<Address> | undefined;
  const refresh = (): Promise<Address> => {
    reading ??= (async () => {
      triedAt = clock();
      try {
        const resolver = (await readResolver()) as Address;
        held = resolver;
        failure = undefined;
        return resolver;
      } catch (error) {
        failure = { error };
        throw error;
      } finally {
        reading = undefined;
      }
    })();
    return reading;
  };
  return async (signer) => {
    if (held !== undefined && signer === held) return true;
    if (reading !== undefined) return signer === (await reading);
    if (triedAt !== undefined && clock() - triedAt < RESOLVER_REFRESH_MS) {
      if (failure !== undefined) throw failure.error;
      return false;
    }
    return signer === (await refresh());
  };
}

const bodySchema = z.strictObject({
  passportId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  openedAt: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  upheld: z.boolean(),
  reasons: z.string().max(REASONS_BODY_LIMIT),
  deadline: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
});

export interface DecisionRouteOptions {
  /** Replaces the chain read; under a test runner the default reads nothing and the route answers 503. */
  chain?: DecisionChain;
  /** Replaces the reasons store; by default a file in the data folder, memory under a test runner. */
  store?: ReasonsStore;
  /** Replaces the pin, for tests. */
  pin?: (document: ReasonsDocument, name: string) => Promise<{ cid: string; uri: `ipfs://${string}` }>;
  /** Replaces REASONS_PER_DAY, for tests. */
  perDay?: number;
  clock?: () => number;
}

/**
 * The resolver's reasons for a challenge decision (L28).
 *
 * POST /decisions/reasons takes `{ passportId, openedAt, upheld, reasons, deadline, signature }`. The
 * signature is the resolver's wallet over EIP-712 DecisionReasons(passportId, openedAt, upheld,
 * reasonsHash, deadline) in Moolam's registry domain, reasonsHash the sha256 of the reasons' UTF-8
 * bytes. A signature that does not recover to the resolver the gate holds is refused before any chain
 * read (resolverGate). In the same call the service then reads, at one block, the resolver from the policy
 * MoolamDecisions reads, getDispute on the registry and MoolamDecisions.published, and accepts only
 * when the deadline has not passed by that block's time, the plain 65 byte signature recovers to that
 * resolver, the dispute is settled with that openedAt and that outcome, and its reasons are not yet
 * published. The reasons are then held to the text rule and pinned as one document naming the
 * passport, openedAt, the outcome and the resolver, and the route answers its ipfs:// address, which
 * always fits MoolamDecisions.publish. The same reasons for the same decision answer the same address
 * without a second pin.
 *
 * The reasons go into no log line. The answer is `no-store`.
 */
export async function decisionRoutes(app: FastifyInstance, options: DecisionRouteOptions = {}): Promise<void> {
  const chain = options.chain ?? (env.NODE_ENV === "test" ? offlineDecisionChain() : liveDecisionChain());
  const store =
    options.store ??
    new ReasonsStore(stateFile(STATE_FILES.decisionReasons), (line) => {
      app.log.warn(line);
    });
  const pin = options.pin ?? (async (document: ReasonsDocument, name: string) => await pinJson(document, name));
  const clock = options.clock ?? Date.now;
  const registry = env.MOOLAM_REGISTRY_ADDRESS as Hex;
  // The studio's day counter with its fail-closed file, reused under a file of its own: only its
  // "prepares" count is taken, once per pin, and every other action is shut.
  const dayFile = stateFile(STATE_FILES.decisionReasonsDay);
  const reasonsDay = globalDay({ prepares: options.perDay ?? REASONS_PER_DAY, generations: 0, edits: 0, unseals: 0, links: 0 }, clock, {
    store: dayFile === undefined ? memoryDayStore() : fileDayStore(dayFile),
    log: (line) => {
      app.log.warn(line);
    },
  });
  const isResolver = resolverGate(() => chain.resolverNow(), clock);
  /** Documents being pinned right now, so two identical requests racing pin at most once. */
  const pinning = new Set<string>();

  if (store.closed() !== undefined) {
    app.log.warn("decision reasons closed: the reasons file could not be believed, the route answers 503");
  }

  app.addHook("onSend", async (_request, reply) => {
    reply.header("cache-control", "no-store");
  });

  const refuse = (request: FastifyRequest, reply: FastifyReply, status: number, error: string, extra: Record<string, unknown> = {}): FastifyReply => {
    request.log.warn({ ip: request.ip, status, reason: error }, "rejected: decision reasons");
    return reply.code(status).send({ error, ...extra });
  };

  app.post("/decisions/reasons", { bodyLimit: REASONS_BODY_LIMIT }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = bodySchema.safeParse(request.body);
    if (!body.success) {
      return refuse(
        request,
        reply,
        400,
        'send {"passportId":"0x<64 hex>","openedAt":<unix seconds>,"upheld":true|false,"reasons":"...","deadline":<unix seconds>,"signature":"0x..."}',
      );
    }
    const passportId = passportKey(body.data.passportId);
    const { upheld, reasons } = body.data;
    const openedAt = BigInt(body.data.openedAt);
    const deadline = BigInt(body.data.deadline);
    const signature = body.data.signature.toLowerCase() as Hex;
    const notTheResolver = (): FastifyReply =>
      refuse(request, reply, 403, "not-the-resolver", {
        reason: "the signature does not recover to the policy's resolver: a plain wallet signature over these reasons, this decision and this deadline is needed",
      });

    const digest = reasonsDigest({ passportId, openedAt, upheld, reasonsHash: reasonsHashOf(reasons), deadline }, registry);
    const signer = await recoverLikeRegistry(digest, signature);
    if (signer === undefined) return notTheResolver();
    let passes: boolean;
    try {
      passes = await isResolver(signer);
    } catch (error) {
      request.log.warn({ reason: safeReason(error) }, "decision reasons: the resolver could not be read");
      return refuse(request, reply, 503, "chain-unreachable");
    }
    if (!passes) return notTheResolver();

    let read;
    try {
      read = await chain.decisionAt(passportId, openedAt);
    } catch (error) {
      request.log.warn({ reason: safeReason(error) }, "decision reasons: the chain could not be read");
      return refuse(request, reply, 503, "chain-unreachable");
    }
    const { now, resolver, dispute, published } = read;

    if (now > deadline) return refuse(request, reply, 403, "reasons-expired", { chainTime: now.toString() });

    // The gate's resolver may be up to a minute old; this one is from the same block as the dispute.
    if (signer !== resolver) return notTheResolver();

    if (dispute.status !== DISPUTE_UPHELD && dispute.status !== DISPUTE_REJECTED) {
      return refuse(request, reply, 409, "dispute-not-settled");
    }
    if (dispute.openedAt !== openedAt || (dispute.status === DISPUTE_UPHELD) !== upheld) {
      return refuse(request, reply, 409, "dispute-mismatch", {
        reason: "the registry's settled dispute for this passport has another openedAt or another outcome",
      });
    }
    if (published) return refuse(request, reply, 409, "already-published");

    const textProblem = reasonsTextProblem(reasons);
    if (textProblem !== null) return refuse(request, reply, 400, textProblem);

    const document = reasonsDocument({ registry, passportId, openedAt, upheld, resolver: signer, reasons });
    const key = reasonsKey(document);
    try {
      const earlier = store.find(key);
      if (earlier !== undefined) return reply.send({ reasonsURI: earlier.reasonsURI });
    } catch (error) {
      if (!(error instanceof ReasonsStoreClosed)) throw error;
      return refuse(request, reply, 503, "reasons-unavailable");
    }
    if (pinning.has(key)) return refuse(request, reply, 409, "pinning");

    const slot = reasonsDay.tryTake("prepares");
    if (!slot.ok) {
      const refusal = dayLimitRefusal(slot.use, clock());
      request.log.warn({ used: slot.use.used, max: slot.use.max }, "rejected: decision reasons, today's ceiling is spent");
      return reply.code(429).header("retry-after", String(refusal.retryAfter)).send(refusal.body);
    }

    pinning.add(key);
    try {
      let pinned: { cid: string; uri: `ipfs://${string}` };
      try {
        pinned = await pin(document, `decision-reasons-${passportId}-${openedAt}.json`);
      } catch (error) {
        // Only a refusal proves nothing landed on Pinata; anything else may have spent the slot.
        if (error instanceof PinRefused) slot.giveBack();
        request.log.error({ passportId, reason: safeReason(error) }, "decision reasons: pin failed, nothing kept");
        return refuse(request, reply, 502, "pin-failed");
      }
      if (!fitsDecisions(pinned.uri)) {
        request.log.error({ passportId, length: pinned.uri.length }, "decision reasons: the pinned address does not fit MoolamDecisions");
        return refuse(request, reply, 502, "address-unfit");
      }
      try {
        store.add({ reasonsURI: pinned.uri, document });
      } catch (error) {
        if (!(error instanceof ReasonsStoreClosed)) throw error;
        return refuse(request, reply, 503, "reasons-unavailable");
      }
      request.log.info({ passportId, openedAt: openedAt.toString(), upheld, resolver: signer }, "decision reasons pinned");
      return reply.send({ reasonsURI: pinned.uri });
    } finally {
      pinning.delete(key);
    }
  });
}
