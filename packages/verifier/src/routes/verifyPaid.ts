import type { x402HTTPResourceServer } from "@x402/core/server";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { contextFor } from "../x402/plugin.js";
import { readUpload, statusOf, verifyBytes } from "./shared.js";

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
 * only after the match succeeds, so a failed verification never charges.
 *
 * The route is mounted only when X402_ENABLED is true. Otherwise the path does
 * not exist and the service answers 404.
 */
export async function verifyPaidRoutes(
  app: FastifyInstance,
  options: { payments: x402HTTPResourceServer },
): Promise<void> {
  const { payments } = options;
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
      let settled: Awaited<ReturnType<typeof payments.processSettlement>>;
      try {
        settled = await payments.processSettlement(
          processed.paymentPayload,
          processed.paymentRequirements,
          processed.declaredExtensions,
          { request: context, responseBody: Buffer.from(JSON.stringify(payload)) },
        );
      } catch (error) {
        // The answer is already computed but nobody has been charged, so the
        // authorisation is released rather than left standing against the payer.
        const reason = error instanceof Error ? error.message : String(error);
        await processed.cancellationDispatcher.cancel({ reason: "handler_failed", responseStatus: 502 });
        request.log.error({ ip: request.ip, url: request.url, reason }, "rejected: settlement threw");
        return reply.code(502).send({ error: `the payment could not be settled: ${reason}` });
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
