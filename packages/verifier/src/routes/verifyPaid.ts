import type { x402HTTPResourceServer } from "@x402/core/server";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { readManifest, type ManifestSummary } from "../c2pa.js";
import { MAX_UPLOAD_BYTES } from "../env.js";
import { matchImage, type MatchResult } from "../match.js";
import { contextFor } from "../x402/plugin.js";

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
      payload = await verifyUpload(request, app);
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
      const settled = await payments.processSettlement(
        processed.paymentPayload,
        processed.paymentRequirements,
        processed.declaredExtensions,
        { request: context, responseBody: Buffer.from(JSON.stringify(payload)) },
      );
      if (!settled.success) {
        request.log.error({ ip: request.ip, url: request.url, reason: settled.errorReason }, "payment did not settle");
        return reply.code(settled.response.status).headers(settled.response.headers).send(settled.response.body ?? {});
      }
      reply.headers(settled.headers);
    }

    return reply.send(payload);
  });
}

class BadUpload extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

function statusOf(error: unknown): number {
  return error instanceof BadUpload ? error.statusCode : 400;
}

async function verifyUpload(
  request: FastifyRequest,
  app: FastifyInstance,
): Promise<{ result: unknown; manifest: unknown }> {
  if (!request.isMultipart()) {
    throw new BadUpload('send the image in a multipart field named "file"');
  }

  const part = await request.file({ limits: { fileSize: MAX_UPLOAD_BYTES } });
  if (part === undefined || part.fieldname !== "file") {
    throw new BadUpload('send the image in a multipart field named "file"');
  }

  let bytes: Buffer;
  try {
    bytes = await part.toBuffer();
  } catch (error) {
    if ((error as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
      throw new BadUpload(`the image is larger than the ${MAX_UPLOAD_BYTES} byte limit`, 413);
    }
    throw error;
  }
  if (bytes.length === 0) {
    throw new BadUpload("the uploaded file is empty");
  }

  let result: MatchResult;
  let manifest: ManifestSummary;
  try {
    [result, manifest] = await Promise.all([
      matchImage(bytes, app.verifier.index, app.verifier.lookupExact),
      readManifest(bytes),
    ]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new BadUpload(`the upload is not an image we can read: ${detail}`);
  }

  return { result: renderResult(result), manifest: renderManifest(manifest) };
}

/** The 64-bit pHash goes out as a decimal string, never a double, exactly as the free route sends it. */
function renderResult(result: MatchResult): unknown {
  return {
    exact: result.exact,
    best: result.best,
    matches: result.matches,
    confidence: result.confidence,
    queried: { ...result.queried, phash: result.queried.phash.toString() },
  };
}

function renderManifest(manifest: ManifestSummary): unknown {
  if (manifest.softBinding === undefined) {
    return manifest;
  }
  return {
    ...manifest,
    softBinding: { ...manifest.softBinding, phash: manifest.softBinding.phash.toString() },
  };
}
