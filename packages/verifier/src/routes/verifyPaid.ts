import { createHash } from "node:crypto";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { HTTPRequestContext, ProcessSettleResultResponse, x402HTTPResourceServer } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isAddress, type Hex } from "viem";
import { withPassportFacts } from "../disputeRead.js";
import { env } from "../env.js";
import { readClient } from "../reputation/registry.js";
import { paymentLedger, type LedgerEntry, type PaymentLedger } from "../x402/ledger.js";
import { assertPaidRoute, contextFor, PAID_VERIFY_PATH, PAYMENT_SIGNATURE_HEADER } from "../x402/plugin.js";
import { readUpload, statusOf, verifyBytes } from "./shared.js";

/** What the facilitator calls a transfer it has broadcast but not yet seen confirmed. */
const SETTLEMENT_PENDING = "settlement_pending";

/**
 * How long to wait before asking the facilitator once more about a pending
 * settlement, or about one whose outcome is unknown. The x402 library already
 * retries with no gap, so the only thing a second ask of our own adds is the time
 * in between: long enough for a Monad block to confirm, short enough that the
 * caller is not left hanging.
 */
export const PENDING_SETTLEMENT_RETRY_MS = 5_000;

/**
 * The shape every x402 facilitator gives a refusal reason: a lower case code such as
 * insufficient_funds. A reason in words is the x402 library passing on a thrown error, a network
 * failure or a timeout, which says nothing about whether the transfer happened.
 */
const FACILITATOR_REASON = /^[a-z][a-z0-9_]*$/;

const NONCE = /^0x[0-9a-fA-F]{64}$/;

/** The one call the chain is asked: whether an EIP-3009 authorisation has been used. */
const AUTHORIZATION_STATE_ABI = [
  {
    type: "function",
    name: "authorizationState",
    stateMutability: "view",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/**
 * Whether the chain shows this payment's authorisation as used, which is the payer having been
 * charged. Undefined means the chain could not be asked or could not say.
 */
export type ChargedCheck = (payment: PaymentPayload, requirements: PaymentRequirements) => Promise<boolean | undefined>;

/** The request fields every log line here carries. */
interface Where {
  ip: string;
  url: string;
}

/**
 * How one payment ended.
 *
 * "settled" and "broadcast" both mean the payer's money is moving, so both
 * answer with the verification. "refused" means the facilitator said no transfer
 * exists, so nothing is served. "unknown" means nobody could say, so the answer
 * is held back and kept against this payment, never thrown away as refused.
 */
type Settlement =
  | { state: "settled" | "broadcast"; headers: Record<string, string> }
  | { state: "refused"; status: number; headers: Record<string, string>; body: unknown }
  | { state: "unknown"; reason: string };

/** A settle answer that is not a success, which is the one that carries a response to send. */
type SettleFailure = Extract<ProcessSettleResultResponse, { success: false }>;

/** One ask of the facilitator, sorted. */
type Attempt =
  | { kind: "settled"; headers: Record<string, string> }
  | { kind: "broadcast"; result: SettleFailure }
  | { kind: "refused"; result: SettleFailure }
  | { kind: "unknown"; reason: string };

/** A transfer the facilitator has put on chain: pending, and carrying the hash that proves it. */
function isBroadcast(settled: ProcessSettleResultResponse): boolean {
  return !settled.success && settled.errorReason === SETTLEMENT_PENDING && settled.transaction.length > 0;
}

/**
 * The facilitator's own refusal: a reason code and no transaction. Anything else that is not a
 * success, a thrown error included, is unknown. Covers every refusal an x402 facilitator writes;
 * does not cover a facilitator that answers in words, which is read as unknown and asked again.
 */
function isRefusal(settled: ProcessSettleResultResponse): boolean {
  const reason = settled.errorReason ?? "";
  return !settled.success && FACILITATOR_REASON.test(reason) && settled.transaction.length === 0;
}

async function attempt(settle: () => Promise<ProcessSettleResultResponse>): Promise<Attempt> {
  let result: ProcessSettleResultResponse;
  try {
    result = await settle();
  } catch (error) {
    return { kind: "unknown", reason: error instanceof Error ? error.message : String(error) };
  }
  if (result.success) return { kind: "settled", headers: result.headers };
  if (isBroadcast(result)) return { kind: "broadcast", result };
  if (isRefusal(result)) return { kind: "refused", result };
  return { kind: "unknown", reason: result.errorReason ?? "the facilitator gave no reason" };
}

const pause = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

/** A payment as it is compared: the nonce it is kept under, and every signed field with the signature. */
interface PaymentIdentity {
  nonce: string;
  identity: string;
}

/**
 * The same reading for a payment offered in a header and for the one the facilitator verified, so
 * a repeat is compared after one normaliser on both sides. Undefined for anything that is not a
 * signed EIP-3009 authorisation with every field present.
 */
function identityOf(payment: unknown): PaymentIdentity | undefined {
  const inner = (payment as { payload?: unknown } | null | undefined)?.payload as
    | { signature?: unknown; authorization?: Record<string, unknown> }
    | undefined;
  const authorization = inner?.authorization;
  const fields = [
    inner?.signature,
    authorization?.from,
    authorization?.to,
    authorization?.value,
    authorization?.validAfter,
    authorization?.validBefore,
    authorization?.nonce,
  ];
  if (!fields.every((field) => typeof field === "string" && field.length > 0)) {
    return undefined;
  }
  const nonce = (authorization?.nonce as string).toLowerCase();
  if (!NONCE.test(nonce)) {
    return undefined;
  }
  return { nonce, identity: (fields as string[]).map((field) => field.toLowerCase()).join("|") };
}

/** The payment this request offers, read from its header without trusting it. */
function offeredPayment(context: HTTPRequestContext): PaymentIdentity | undefined {
  const header = context.adapter.getHeader(PAYMENT_SIGNATURE_HEADER);
  if (header === undefined || header.length === 0) {
    return undefined;
  }
  try {
    return identityOf(decodePaymentSignatureHeader(header));
  } catch {
    return undefined;
  }
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The live check: USDC's own authorizationState for the payer and nonce, on the asset the payment
 * names. Anything malformed, or a read that fails, is undefined.
 */
function chainCharged(): ChargedCheck {
  const chain = readClient();
  return async (payment, requirements) => {
    const authorization = (payment.payload as { authorization?: { from?: unknown; nonce?: unknown } } | undefined)
      ?.authorization;
    const from = authorization?.from;
    const nonce = authorization?.nonce;
    const asset = requirements.asset;
    if (typeof from !== "string" || !isAddress(from) || typeof nonce !== "string" || !NONCE.test(nonce)) {
      return undefined;
    }
    if (typeof asset !== "string" || !isAddress(asset)) {
      return undefined;
    }
    try {
      return (await chain.readContract({
        address: asset,
        abi: AUTHORIZATION_STATE_ABI,
        functionName: "authorizationState",
        args: [from, nonce as Hex],
      })) as boolean;
    } catch {
      return undefined;
    }
  };
}

/**
 * Settles the payment and says what the route may answer with.
 *
 * - the facilitator confirms the transfer: "settled", with its receipt.
 * - the facilitator has broadcast it but not confirmed it: ask once more after a
 *   pause, then "broadcast" with the first receipt. The money is already on its
 *   way, so the payer gets the answer. A second call that throws, or that comes
 *   back a different failure, cannot recall that transfer, so it is logged and
 *   the first answer stands.
 * - the facilitator names a reason: "refused", and nothing is served.
 * - nobody can say (a thrown call, a reason in words): the chain is asked whether
 *   the payment was spent, and if it cannot say, the facilitator is asked once
 *   more after a pause. A spent payment is "broadcast"; a refusal on that second
 *   ask counts only when the chain says the payment was not spent, because a
 *   first call that did land makes the second one fail too. Otherwise "unknown":
 *   never "refused", because the payer may have been charged.
 */
async function settleSequence(
  settle: () => Promise<ProcessSettleResultResponse>,
  charged: () => Promise<boolean | undefined>,
  retryDelayMs: number,
  log: FastifyBaseLogger,
  where: Where,
): Promise<Settlement> {
  const first = await attempt(settle);

  if (first.kind === "settled") {
    return { state: "settled", headers: first.headers };
  }
  if (first.kind === "refused") {
    log.error({ ...where, reason: first.result.errorReason }, "payment did not settle");
    return {
      state: "refused",
      status: first.result.response.status,
      headers: first.result.response.headers,
      body: first.result.response.body ?? {},
    };
  }

  if (first.kind === "broadcast") {
    log.warn({ ...where, transaction: first.result.transaction }, "settlement pending: asking the facilitator once more");
    await pause(retryDelayMs);
    const second = await attempt(settle);
    if (second.kind === "settled") {
      return { state: "settled", headers: second.headers };
    }
    if (second.kind !== "broadcast") {
      log.warn(
        { ...where, second: second.kind, transaction: first.result.transaction },
        "the second settle call did not confirm it; the broadcast transfer stands",
      );
    }
    // The authorisation is signed for this one amount and the transfer is on
    // chain, so it cannot be spent twice and the money lands when it confirms.
    // Cancelling here would throw away a transfer that is already on its way, and
    // withholding the answer would take the payment and give nothing back.
    return { state: "broadcast", headers: first.result.headers };
  }

  log.warn({ ...where, reason: first.reason }, "settlement outcome unknown: asking the chain, then the facilitator once more");
  if ((await charged()) === true) {
    return { state: "broadcast", headers: {} };
  }
  await pause(retryDelayMs);
  const second = await attempt(settle);
  if (second.kind === "settled") {
    return { state: "settled", headers: second.headers };
  }
  if (second.kind === "broadcast") {
    return { state: "broadcast", headers: second.result.headers };
  }
  const spent = await charged();
  if (spent === true) {
    return { state: "broadcast", headers: {} };
  }
  if (second.kind === "refused" && spent === false) {
    log.error({ ...where, reason: second.result.errorReason }, "payment did not settle");
    return {
      state: "refused",
      status: second.result.response.status,
      headers: second.result.response.headers,
      body: second.result.response.body ?? {},
    };
  }
  const reason = second.kind === "unknown" ? second.reason : (second.result.errorReason ?? "refused");
  log.error({ ...where, first: first.reason, second: reason }, "settlement outcome unknown: the answer is held against this payment");
  return { state: "unknown", reason };
}

/**
 * POST /verify/paid: the same answer as /verify, behind an x402 payment.
 *
 * It takes a multipart upload in a field named "file" only. The free route
 * also accepts a remote URL, and that path carries the checks that stop a
 * fetch from reaching a private address; rather than copy those checks and
 * risk the two copies drifting, the paid route does not offer it.
 *
 * The consent statement, the dispute fact, the re-check fact and the picture state are attached
 * before the payment is settled, so the body the facilitator sees and the copy kept against a
 * replayed payment are the same answer the payer is served. The reads for one passport start at
 * the same moment, so a caller never waits through one timeout and then another.
 *
 * A caller with no payment gets 402 and the payment terms. A caller whose
 * payment fails verification gets the facilitator's reason. Payment is settled
 * only after the match succeeds, so a failed verification never charges. A
 * settlement the facilitator has broadcast but not yet confirmed is asked about
 * once more, then answered with the verification and a pending receipt. A
 * settlement whose outcome nobody can tell answers 502 settlement-unknown and is
 * never cancelled; the answer is kept against the payment and handed over when
 * the same payment and file come back and the chain shows the payment spent.
 *
 * A payment that already bought an answer is given that same answer back rather
 * than being settled a second time, but only to a request carrying that very
 * payment, every signed field and the signature, and the same file (V7). The
 * nonce alone is public on chain once the transfer settles, so it opens nothing.
 *
 * The route is mounted only when X402_ENABLED is true. Otherwise the path does
 * not exist and the service answers 404.
 */
export async function verifyPaidRoutes(
  app: FastifyInstance,
  options: {
    payments: x402HTTPResourceServer;
    settlementRetryDelayMs?: number;
    ledger?: PaymentLedger;
    /** Replaces the chain read that says whether a payment was spent. Under a test runner the default answers undefined. */
    charged?: ChargedCheck;
  },
): Promise<void> {
  assertPaidRoute(app);

  const { payments } = options;
  const retryDelayMs = options.settlementRetryDelayMs ?? PENDING_SETTLEMENT_RETRY_MS;
  const ledger = options.ledger ?? paymentLedger();
  const charged: ChargedCheck = options.charged ?? (env.NODE_ENV === "test" ? async () => undefined : chainCharged());
  let ready: Promise<void> | undefined;

  app.post(PAID_VERIFY_PATH, async (request: FastifyRequest, reply: FastifyReply) => {
    const context = contextFor(request);
    const where: Where = { ip: request.ip, url: request.url };
    const offered = offeredPayment(context);

    // Read only for a repeat of a payment this service remembers, and handed on below so the
    // upload is never read twice.
    let bytes: Buffer | undefined;
    if (offered !== undefined) {
      const seen = ledger.get(offered.nonce);
      if (seen !== undefined && seen.payment === offered.identity) {
        try {
          bytes = await readUpload(request);
        } catch (error) {
          const status = statusOf(error);
          return reply.code(status).send({ error: error instanceof Error ? error.message : String(error) });
        }
        const replay = await replayFor(seen, bytes, charged);
        if (replay !== undefined) {
          request.log.info({ ...where, state: replay.state }, "replayed: this payment already bought an answer");
          if (replay !== seen) {
            ledger.remember(offered.nonce, replay);
          }
          return reply.headers(replay.headers).send(replay.payload);
        }
        if (seen.state === "unknown") {
          // The chain says this payment was not spent, so it goes through as new.
          ledger.forget(offered.nonce);
        }
      }
    }

    try {
      ready = ready ?? payments.initialize();
      await ready;
    } catch (error) {
      ready = undefined;
      const reason = error instanceof Error ? error.message : String(error);
      request.log.error({ ...where, reason }, "rejected: x402 facilitator unreachable");
      return reply.code(502).send({ error: `the payment facilitator did not answer: ${reason}` });
    }

    let processed;
    try {
      processed = await payments.processHTTPRequest(context);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      request.log.error({ ...where, reason }, "rejected: x402 could not read the payment");
      return reply.code(502).send({ error: `the payment could not be checked: ${reason}` });
    }

    if (processed.type === "payment-error") {
      const { status, headers, body } = processed.response;
      request.log.warn({ ...where, status }, "rejected: payment required");
      return reply.code(status).headers(headers).send(body ?? {});
    }

    if (processed.type !== "payment-verified") {
      // x402 found nothing to collect on a route that exists only to collect,
      // which means its route table and the mounted path disagree. Serving the
      // answer here would give the work away free, so the route fails shut and
      // the configuration gets fixed instead.
      request.log.error(
        { ...where, route: request.routeOptions.url, result: processed.type },
        "rejected: the paid route is not under the x402 payment table",
      );
      return reply.code(500).send({ error: "payment-misconfigured" });
    }

    const verified = processed;

    let payload: { result: unknown; manifest: unknown };
    try {
      bytes = bytes ?? (await readUpload(request));
      const answer = await verifyBytes(app, bytes);
      payload = await withPassportFacts(
        answer,
        app.verifier.consent,
        app.verifier.dispute,
        app.verifier.lookupExact,
        app.verifier.picture,
      );
    } catch (error) {
      const status = statusOf(error);
      const reason = error instanceof Error ? error.message : String(error);
      await verified.cancellationDispatcher.cancel({ reason: "handler_failed", responseStatus: status });
      request.log.warn({ ...where, status, reason }, "rejected: /verify/paid");
      return reply.code(status).send({ error: reason });
    }

    const settlement = await settleSequence(
      async () =>
        payments.processSettlement(
          verified.paymentPayload,
          verified.paymentRequirements,
          verified.declaredExtensions,
          { request: context, responseBody: Buffer.from(JSON.stringify(payload)) },
        ),
      async () => await charged(verified.paymentPayload, verified.paymentRequirements),
      retryDelayMs,
      request.log,
      where,
    );

    if (settlement.state === "refused") {
      return reply.code(settlement.status).headers(settlement.headers).send(settlement.body);
    }

    // The ledger is keyed by the payment the facilitator verified, never by the header's own word.
    const paid = identityOf(verified.paymentPayload);
    const upload = sha256Hex(bytes);

    if (settlement.state === "unknown") {
      if (paid !== undefined) {
        ledger.remember(paid.nonce, {
          state: "unknown",
          payload,
          headers: {},
          payment: paid.identity,
          upload,
          proof: { payment: verified.paymentPayload, requirements: verified.paymentRequirements },
        });
      }
      return reply.code(502).send({
        error: "settlement-unknown",
        reason:
          "the payment facilitator did not say whether your payment went through. Nothing was cancelled. Send the same payment with the same file again: once the chain shows the payment, the answer it bought is handed over, and a payment that never happened is not taken twice.",
      });
    }

    if (paid !== undefined) {
      ledger.remember(paid.nonce, {
        state: settlement.state === "settled" ? "settled" : "pending",
        payload,
        headers: settlement.headers,
        payment: paid.identity,
        upload,
      });
    }

    reply.headers(settlement.headers);
    return reply.send(payload);
  });
}

/**
 * The answer a repeat of a remembered payment gets, or undefined when it gets none from memory.
 * The file must be the one the answer is about. An answer held back as unknown is handed over only
 * once the chain shows the payment spent, and comes back marked settled so the chain is not asked
 * again.
 */
async function replayFor(seen: LedgerEntry, bytes: Buffer, charged: ChargedCheck): Promise<LedgerEntry | undefined> {
  if (sha256Hex(bytes) !== seen.upload) {
    return undefined;
  }
  if (seen.state !== "unknown") {
    return seen;
  }
  const proof = seen.proof as { payment: PaymentPayload; requirements: PaymentRequirements } | undefined;
  if (proof === undefined || (await charged(proof.payment, proof.requirements)) !== true) {
    return undefined;
  }
  return { ...seen, state: "settled" };
}
