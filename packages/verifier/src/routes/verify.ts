import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { withPassportFacts } from "../disputeRead.js";
import { safeReason } from "../net/errorText.js";
import {
  SERVICE_FAULT_REASON,
  ServiceFault,
  giveBackUploads,
  readFromUrl,
  readUpload,
  statusOf,
  verifyBytes,
} from "./shared.js";

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
 * picture, read from the records this service already holds, and whether the picture is public,
 * sealed, or sealed and published later by its holder, read from its metadata document and its
 * unseal record. The reads for one passport start at the same moment, so a caller never waits
 * through one timeout and then another. A read that fails leaves that field as
 * { source: "unavailable" } and the match stands.
 *
 * Answers 503 `busy` when no matching slot came free in time, and 503 `service-fault` with
 * SERVICE_FAULT_REASON when this service, not the picture, failed while matching.
 */
export async function verifyRoutes(app: FastifyInstance): Promise<void> {
  app.post("/verify", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const bytes = request.isMultipart() ? await readUpload(request) : await readFromUrl(request);
      const answer = await verifyBytes(app, bytes);
      return reply.send(
        await withPassportFacts(
          answer,
          app.verifier.consent,
          app.verifier.dispute,
          app.verifier.lookupExact,
          app.verifier.picture,
        ),
      );
    } catch (error) {
      const status = statusOf(error);
      const reason = safeReason(error);
      request.log.warn({ ip: request.ip, url: request.url, status, reason }, "rejected: /verify");
      // A fault of this service says so in words, so the caller knows their picture is fine.
      if (error instanceof ServiceFault) {
        return reply.code(503).send({ error: "service-fault", reason: SERVICE_FAULT_REASON });
      }
      // A full gate is the one other failure the caller can do nothing about but retry, so it goes
      // out as the same one word the other busy routes use rather than an internal wait time.
      return reply.code(status).send({ error: status === 503 ? "busy" : reason });
    } finally {
      // Only here, with the answer written, has this route let go of the upload: counting it back
      // when the response closed let a caller who hung up leave it in memory uncounted.
      giveBackUploads(request);
    }
  });
}
