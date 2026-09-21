import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { withPassportFacts } from "../disputeRead.js";
import { readFromUrl, readUpload, statusOf, verifyBytes } from "./shared.js";

/**
 * POST /verify: takes an image, returns the passport it belongs to.
 *
 * Accepts either a multipart upload in a field named "file" or a JSON body of
 * { "url": "..." }. The upload and the fetched image are capped at 20 MB, the JSON body at 16 KB,
 * and the URL form is fetched server-side with a 10 second timeout, refusing any address inside
 * our own network before and after every redirect.
 *
 * The matched passport carries what its holder stated about AI use, read from the consent
 * contract, whether it is under dispute, read from the registry, and what has re-checked the
 * picture, read from the records this service already holds. The two chain reads for one passport
 * start at the same moment, so a caller never waits through one timeout and then the other. A read
 * that fails leaves that field as { source: "unavailable" } and the match stands.
 *
 * Answers 503 `busy` when no matching slot came free in time.
 */
export async function verifyRoutes(app: FastifyInstance): Promise<void> {
  app.post("/verify", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const bytes = request.isMultipart() ? await readUpload(request) : await readFromUrl(request);
      const answer = await verifyBytes(app, bytes);
      return reply.send(
        await withPassportFacts(answer, app.verifier.consent, app.verifier.dispute, app.verifier.lookupExact),
      );
    } catch (error) {
      const status = statusOf(error);
      const reason = error instanceof Error ? error.message : String(error);
      request.log.warn({ ip: request.ip, url: request.url, status, reason }, "rejected: /verify");
      // A full gate is the one failure the caller can do nothing about but retry, so it goes out
      // as the same one word the other busy routes use rather than an internal wait time.
      return reply.code(status).send({ error: status === 503 ? "busy" : reason });
    }
  });
}
