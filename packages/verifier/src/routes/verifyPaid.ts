import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { HTTPRequestContext, ProcessSettleResultResponse, x402HTTPResourceServer } from "@x402/core/server";
import type { PaymentPayload } from "@x402/core/types";
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { withConsentAndDispute } from "../disputeRead.js";
import { paymentLedger, type PaymentLedger } from "../x402/ledger.js";
import { assertPaidRoute, contextFor, PAID_VERIFY_PATH, PAYMENT_SIGNATURE_HEADER } from "../x402/plugin.js";
import { readUpload, statusOf, verifyBytes } from "./shared.js";

/** What the facilitator calls a transfer it has broadcast but not yet seen confirmed. */
const SETTLEMENT_PENDING = "settlement_pending";

/**
 * How long to wait before asking the facilitator once more about a pending
 * settlement. The x402 library already retries with no gap, so the only thing a
 * second ask of our own adds is the time in between: long enough for a Monad
 * block to confirm, short enough that the caller is not left hanging.
 */
export const PENDING_SETTLEMENT_RETRY_MS = 5_000;

/** The request fields every log line here carries. */
interface Where {
  ip: string;
  url: string;
}

/**
 * How one payment ended.
 *
 * "settled" and "broadcast" both mean the payer's money is moving, so both
 * answer with the verification. "refused" means no transfer exists, so nothing
 * is served.
 */
type Settlement =
  | { state: "settled" | "broadcast"; headers: Record<string, string> }
  | { state: "refused"; cancel: boolean; status: number; headers: Record<string, string>; body: unknown };

/** A transfer the facilitator has put on chain: pending, and carrying the hash that proves it. */
function isBroadcast(settled: ProcessSettleResultResponse): boolean {
  return !settled.success && settled.errorReason === SETTLEMENT_PENDING && settled.transaction.length > 0;
}

const pause = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The EIP-3009 nonce the payer signed, which is the one thing that names this
 * authorisation.
 *
 * Undefined when the request carries no payment, when the header cannot be
 * decoded, or when the scheme has no such nonce. The route then runs as it does
 * for a payment it has never seen.
 */
function authorizationNonce(context: HTTPRequestContext): string | undefined {
  const header = context.adapter.getHeader(PAYMENT_SIGNATURE_HEADER);
  if (header === undefined || header.length === 0) {
    return undefined;
  }

  let payment: PaymentPayload;
  try {
    payment = decodePaymentSignatureHeader(header);
  } catch {
    return undefined;
  }

  const authorization = (payment.payload as { authorization?: { nonce?: unknown } } | undefined)?.authorization;
  const nonce = authorization?.nonce;
  return typeof nonce === "string" && nonce.length > 0 ? nonce.toLowerCase() : undefined;
}

/**
 * Settles the payment and says what the route may answer with.
 *
 * Three outcomes, and nothing else:
 * - the facilitator confirms the transfer: "settled", with its receipt.
 * - the facilitator has broadcast it but not confirmed it: ask once more after a
 *   pause, then "broadcast" with the first receipt. The money is already on its
 *   way, so the payer gets the answer. A second call that throws, or that comes
 *   back a different failure, cannot recall that transfer, so it is logged and
 *   the first answer stands.
 * - nothing was broadcast: "refused", and nothing is served.
 */
async function settleSequence(
  settle: () => Promise<ProcessSettleResultResponse>,
  retryDelayMs: number,
  log: FastifyBaseLogger,
  where: Where,
): Promise<Settlement> {
  let first: ProcessSettleResultResponse;
  try {
    first = await settle();
  } catch (error) {
    // The answer is already computed but nobody has been charged, so the
    // authorisation is released rather than left standing against the payer.
    const reason = error instanceof Error ? error.message : String(error);
    log.error({ ...where, reason }, "rejected: settlement threw");
    return {
      state: "refused",
      cancel: true,
      status: 502,
      headers: {},
      body: { error: `the payment could not be settled: ${reason}` },
    };
  }

  if (first.success) {
    return { state: "settled", headers: first.headers };
  }

  if (!isBroadcast(first)) {
    log.error({ ...where, reason: first.errorReason }, "payment did not settle");
    return {
      state: "refused",
      cancel: false,
      status: first.response.status,
      headers: first.response.headers,
      body: first.response.body ?? {},
    };
  }

  log.warn({ ...where, transaction: first.transaction }, "settlement pending: asking the facilitator once more");
  await pause(retryDelayMs);

  let second: ProcessSettleResultResponse | undefined;
  try {
    second = await settle();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log.warn({ ...where, reason }, "the second settle call did not answer; the broadcast transfer stands");
  }

  if (second !== undefined && second.success) {
    return { state: "settled", headers: second.headers };
  }
  if (second !== undefined && !isBroadcast(second)) {
    log.warn(
      { ...where, reason: second.errorReason, transaction: first.transaction },
      "the second settle call came back a failure; the broadcast transfer stands",
    );
  }

  // The authorisation is signed for this one amount and the transfer is on
  // chain, so it cannot be spent twice and the money lands when it confirms.
  // Cancelling here would throw away a transfer that is already on its way, and
  // withholding the answer would take the payment and give nothing back.
  return { state: "broadcast", headers: first.headers };
}

/**
 * POST /verify/paid: the same answer as /verify, behind an x402 payment.
 *
 * It takes a multipart upload in a field named "file" only. The free route
 * also accepts a remote URL, and that path carries the checks that stop a
 * fetch from reaching a private address; rather than copy those checks and
 * risk the two copies drifting, the paid route does not offer it.
 *
 * The consent statement and the dispute fact are attached before the payment is settled, so the
 * body the facilitator sees and the copy kept against a replayed payment are the same answer the
 * payer is served. The two chain reads for one passport start at the same moment, so a caller
 * never waits through one timeout and then the other.
 *
 * A caller with no payment gets 402 and the payment terms. A caller whose
 * payment fails verification gets the facilitator's reason. Payment is settled
 * only after the match succeeds, so a failed verification never charges. A
 * settlement the facilitator has broadcast but not yet confirmed is asked about
 * once more, then answered with the verification and a pending receipt. A
 * payment that already bought an answer is given that same answer back rather
 * than being settled a second time.
 *
 * The route is mounted only when X402_ENABLED is true. Otherwise the path does
 * not exist and the service answers 404.
 */
export async function verifyPaidRoutes(
  app: FastifyInstance,
  options: { payments: x402HTTPResourceServer; settlementRetryDelayMs?: number; ledger?: PaymentLedger },
): Promise<void> {
  assertPaidRoute(app);

  const { payments } = options;
  const retryDelayMs = options.settlementRetryDelayMs ?? PENDING_SETTLEMENT_RETRY_MS;
  const ledger = options.ledger ?? paymentLedger();
  let ready: Promise<void> | undefined;

  app.post(PAID_VERIFY_PATH, async (request: FastifyRequest, reply: FastifyReply) => {
    const context = contextFor(request);
    const where: Where = { ip: request.ip, url: request.url };
    const nonce = authorizationNonce(context);

    if (nonce !== undefined) {
      const seen = ledger.get(nonce);
      if (seen !== undefined) {
        request.log.info({ ...where, state: seen.state }, "replayed: this payment already bought an answer");
        return reply.headers(seen.headers).send(seen.payload);
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
      const answer = await verifyBytes(app, await readUpload(request));
      payload = await withConsentAndDispute(answer, app.verifier.consent, app.verifier.dispute);
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
      retryDelayMs,
      request.log,
      where,
    );

    if (settlement.state === "refused") {
      if (settlement.cancel) {
        await verified.cancellationDispatcher.cancel({ reason: "handler_failed", responseStatus: settlement.status });
      }
      return reply.code(settlement.status).headers(settlement.headers).send(settlement.body);
    }

    if (nonce !== undefined) {
      ledger.remember(nonce, {
        state: settlement.state === "settled" ? "settled" : "pending",
        payload,
        headers: settlement.headers,
      });
    }

    reply.headers(settlement.headers);
    return reply.send(payload);
  });
}
