import type { ProcessSettleResultResponse, x402HTTPResourceServer } from "@x402/core/server";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { contextFor } from "../x402/plugin.js";
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

function isPending(settled: ProcessSettleResultResponse): boolean {
  return !settled.success && settled.errorReason === SETTLEMENT_PENDING;
}

const pause = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

/**
 * POST /verify/paid: the same answer as /verify, behind an x402 payment.
 *
 * It takes a multipart upload in a field named "file" only. The free route
 * also accepts a remote URL, and that path carries the checks that stop a
 * fetch from reaching a private address; rather than copy those checks and
 * risk the two copies drifting, the paid route does not offer it.
 *
 * A caller with no payment gets 402 and the payment terms. A caller whose
 * payment fails verification gets the facilitator's reason. Payment is settled
 * only after the match succeeds, so a failed verification never charges. A
 * settlement the facilitator has broadcast but not yet confirmed is asked about
 * once more, then answered with the verification and a pending receipt.
 *
 * The route is mounted only when X402_ENABLED is true. Otherwise the path does
 * not exist and the service answers 404.
 */
export async function verifyPaidRoutes(
  app: FastifyInstance,
  options: { payments: x402HTTPResourceServer; settlementRetryDelayMs?: number },
): Promise<void> {
  const { payments } = options;
  const retryDelayMs = options.settlementRetryDelayMs ?? PENDING_SETTLEMENT_RETRY_MS;
  let ready: Promise<void> | undefined;

  app.post("/verify/paid", async (request: FastifyRequest, reply: FastifyReply) => {
    const context = contextFor(request);

    try {
      ready = ready ?? payments.initialize();
      await ready;
    } catch (error) {
      ready = undefined;
      const reason = error instanceof Error ? error.message : String(error);
      request.log.error({ ip: request.ip, url: request.url, reason }, "rejected: x402 facilitator unreachable");
      return reply.code(502).send({ error: `the payment facilitator did not answer: ${reason}` });
    }

    let processed;
    try {
      processed = await payments.processHTTPRequest(context);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      request.log.error({ ip: request.ip, url: request.url, reason }, "rejected: x402 could not read the payment");
      return reply.code(502).send({ error: `the payment could not be checked: ${reason}` });
    }

    if (processed.type === "payment-error") {
      const { status, headers, body } = processed.response;
      request.log.warn({ ip: request.ip, url: request.url, status }, "rejected: payment required");
      return reply.code(status).headers(headers).send(body ?? {});
    }

    let payload: { result: unknown; manifest: unknown };
    try {
      payload = await verifyBytes(app, await readUpload(request));
    } catch (error) {
      const status = statusOf(error);
      const reason = error instanceof Error ? error.message : String(error);
      if (processed.type === "payment-verified") {
        await processed.cancellationDispatcher.cancel({ reason: "handler_failed", responseStatus: status });
      }
      request.log.warn({ ip: request.ip, url: request.url, status, reason }, "rejected: /verify/paid");
      return reply.code(status).send({ error: reason });
    }

    if (processed.type === "payment-verified") {
      const verified = processed;
      const settle = async (): Promise<ProcessSettleResultResponse> =>
        payments.processSettlement(
          verified.paymentPayload,
          verified.paymentRequirements,
          verified.declaredExtensions,
          { request: context, responseBody: Buffer.from(JSON.stringify(payload)) },
        );

      let settled: ProcessSettleResultResponse;
      try {
        settled = await settle();
      } catch (error) {
        // The answer is already computed but nobody has been charged, so the
        // authorisation is released rather than left standing against the payer.
        const reason = error instanceof Error ? error.message : String(error);
        await verified.cancellationDispatcher.cancel({ reason: "handler_failed", responseStatus: 502 });
        request.log.error({ ip: request.ip, url: request.url, reason }, "rejected: settlement threw");
        return reply.code(502).send({ error: `the payment could not be settled: ${reason}` });
      }

      if (isPending(settled)) {
        request.log.warn(
          { ip: request.ip, url: request.url, transaction: settled.transaction },
          "settlement pending: asking the facilitator once more",
        );
        await pause(retryDelayMs);
        try {
          settled = await settle();
        } catch (error) {
          // The facilitator keeps the pending transfer under the payer's
          // signature, so a second ask that fails changes nothing about the
          // money. The first answer stands.
          const reason = error instanceof Error ? error.message : String(error);
          request.log.error({ ip: request.ip, url: request.url, reason }, "the second settle call did not answer");
        }
      }

      if (isPending(settled)) {
        // The authorisation is signed for this one amount and the facilitator
        // holds it, so it cannot be spent twice and the money lands when the
        // transaction confirms. Cancelling here would throw away a transfer
        // that is already on its way, and withholding the answer would take the
        // payment and give nothing back, so the verification goes out with the
        // pending receipt on it.
        request.log.warn(
          { ip: request.ip, url: request.url, transaction: settled.transaction },
          "settlement still pending: answering with the verification and a pending receipt",
        );
        reply.headers(settled.headers);
        return reply.send(payload);
      }

      if (!settled.success) {
        request.log.error({ ip: request.ip, url: request.url, reason: settled.errorReason }, "payment did not settle");
        return reply.code(settled.response.status).headers(settled.response.headers).send(settled.response.body ?? {});
      }
      reply.headers(settled.headers);
    }

    return reply.send(payload);
  });
}
