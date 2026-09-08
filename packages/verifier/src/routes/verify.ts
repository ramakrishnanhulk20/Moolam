import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { readFromUrl, readUpload, statusOf, verifyBytes } from "./shared.js";

/**
 * POST /verify: takes an image, returns the passport it belongs to.
 *
 * Accepts either a multipart upload in a field named "file" or a JSON body of
 * { "url": "..." }. Both are capped at 20 MB, and the URL form is fetched
 * server-side with a 10 second timeout, refusing any address inside our own
 * network before and after every redirect.
 */
export async function verifyRoutes(app: FastifyInstance): Promise<void> {
  app.post("/verify", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const bytes = request.isMultipart() ? await readUpload(request) : await readFromUrl(request);
      return reply.send(await verifyBytes(app, bytes));
    } catch (error) {
      const status = statusOf(error);
      const reason = error instanceof Error ? error.message : String(error);
      request.log.warn({ ip: request.ip, url: request.url, status, reason }, "rejected: /verify");
      return reply.code(status).send({ error: reason });
    }
  });
}
