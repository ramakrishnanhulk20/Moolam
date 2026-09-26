import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { manifestUnreadable, readManifest, type ManifestSummary } from "../c2pa.js";
import { FETCH_TIMEOUT_MS, MAX_UPLOAD_BYTES } from "../env.js";
import { ImageTooLarge, UndecodableImage, UnsupportedImageFormat } from "../fingerprint.js";
import { Busy } from "../generate/gate.js";
import type { MatchResult } from "../match.js";
import { BlockedTarget, UnreachableTarget, safeFetch } from "../net/safeFetch.js";

/** A rejection a caller caused, carrying the status the route should answer with. */
export class BadRequest extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

/** A failure of this service rather than of the request. Routes answer it with its status, 503. */
export class ServiceFault extends Error {
  readonly statusCode = 503;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ServiceFault";
  }
}

const urlBodySchema = z.object({
  url: z.string().refine(isHttpUrl, "url must be an absolute http or https URL"),
});

/**
 * The status a route answers with for an error raised while reading or matching.
 *
 * Any error that carries its own status is believed, which is how a full match gate answers 503
 * without this function knowing what a gate is. Everything else is treated as the caller's
 * mistake, because that is what nearly every failure on this path is.
 */
export function statusOf(error: unknown): number {
  const carried = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof carried === "number" ? carried : 400;
}

/**
 * Reads the image out of a multipart upload.
 *
 * Throws BadRequest when the request carries no file part, when the part is not
 * named "file", when the file is empty, or when it is over the byte limit (413).
 */
export async function readUpload(request: FastifyRequest): Promise<Buffer> {
  if (!request.isMultipart()) {
    throw new BadRequest('send the image in a multipart field named "file"');
  }

  const part = await request.file({ limits: { fileSize: MAX_UPLOAD_BYTES } });
  if (part === undefined) {
    throw new BadRequest('send the image in a multipart field named "file"');
  }
  if (part.fieldname !== "file") {
    throw new BadRequest(`expected a multipart field named "file", got "${part.fieldname}"`);
  }

  let bytes: Buffer;
  try {
    bytes = await part.toBuffer();
  } catch (error) {
    if ((error as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
      throw new BadRequest(`the image is larger than the ${MAX_UPLOAD_BYTES} byte limit`, 413);
    }
    throw error;
  }

  if (bytes.length === 0) {
    throw new BadRequest("the uploaded file is empty");
  }
  return bytes;
}

/**
 * Fetches a remote image within the timeout and the size cap.
 *
 * The address guard and the redirect chain live in src/net/safeFetch.ts. The
 * body is read chunk by chunk and abandoned the moment it crosses the cap,
 * because a Content-Length header is a claim by the remote server, not a fact.
 *
 * Throws BadRequest: 400 for a body that is not { "url": "..." }, 403 for a URL
 * that points inside our own network, 413 over the byte limit, 502 when the
 * remote host does not answer or fails part way through the body.
 */
export async function readFromUrl(request: FastifyRequest): Promise<Buffer> {
  const parsed = urlBodySchema.safeParse(request.body);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => issue.message).join("; ");
    throw new BadRequest(`send a multipart "file" field or a JSON body of { "url": "..." }: ${detail}`);
  }

  let response;
  try {
    response = await safeFetch(new URL(parsed.data.url), { timeoutMs: FETCH_TIMEOUT_MS });
  } catch (error) {
    if (error instanceof BlockedTarget || error instanceof UnreachableTarget) {
      throw new BadRequest(error.message, error.statusCode);
    }
    throw error;
  }

  if (!response.ok || response.body === null) {
    throw new BadRequest(`fetching ${parsed.data.url} returned ${response.status}`, 502);
  }

  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > MAX_UPLOAD_BYTES) {
        throw new BadRequest(`the image at ${parsed.data.url} is larger than the ${MAX_UPLOAD_BYTES} byte limit`, 413);
      }
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    if (error instanceof BadRequest) {
      throw error;
    }
    // A body that stalls past the timeout or a connection the remote drops mid-body is the remote
    // host failing, not the caller, so a client that retries a 5xx gets to retry it.
    const reason = error instanceof Error ? error.message : String(error);
    throw new BadRequest(`fetching ${parsed.data.url} failed part way through: ${reason}`, 502);
  }

  if (total === 0) {
    throw new BadRequest(`the image at ${parsed.data.url} is empty`);
  }
  return Buffer.concat(chunks);
}

/** What a caller is told when this service, not their picture, failed while matching. */
export const SERVICE_FAULT_REASON = "the service could not read this picture right now, try again";

/**
 * Matches an image against the registry and reads any manifest it carries, in
 * the JSON shape both routes answer with.
 *
 * The match runs behind the service's concurrency gate, so a burst of large
 * uploads queues instead of decoding all at once.
 *
 * Throws BadRequest: 413 when the image is over the pixel limit, 400 only when
 * the upload itself is at fault (not one of the three formats, or pixels the
 * decoders refused). Throws ServiceFault, 503 with SERVICE_FAULT_REASON, for
 * anything else, which is this service failing: a blockhash worker that stopped
 * or timed out, a hash of the wrong length, a decoder out of memory, or a
 * failure nobody named. That one is logged, because telling the caller to change
 * a file that is fine would hide it (review pass 6, answers 7). Throws Busy,
 * which carries 503, when no slot came free in time.
 */
export async function verifyBytes(
  app: FastifyInstance,
  bytes: Buffer,
): Promise<{ result: unknown; manifest: unknown }> {
  let result: MatchResult;
  let manifest: ManifestSummary;
  try {
    // readManifest promises never to throw. The catch is for the day it breaks that promise: a
    // manifest problem may cost the answer its manifest, never the match.
    [result, manifest] = await Promise.all([
      app.verifier.runMatch(bytes),
      readManifest(bytes).catch(() => manifestUnreadable()),
    ]);
  } catch (error) {
    if (error instanceof Busy) {
      throw error;
    }
    if (error instanceof ImageTooLarge) {
      throw new BadRequest(error.message, 413);
    }
    const detail = error instanceof Error ? error.message : String(error);
    if (error instanceof UnsupportedImageFormat || error instanceof UndecodableImage) {
      throw new BadRequest(`the upload is not an image we can read: ${detail}`);
    }
    app.log.error(
      { reason: detail, fault: error instanceof Error ? error.name : typeof error },
      "verify: the service failed while matching",
    );
    throw new ServiceFault(SERVICE_FAULT_REASON, { cause: error });
  }

  return { result: renderResult(result), manifest: renderManifest(manifest) };
}

/**
 * Renders the match for JSON: the 64-bit pHash goes out as a decimal string, never a double.
 * `laterSameFingerprint` is newer than the rest of the shape and only rides along when something
 * matched, so a client that predates it reads the same answer it always did. `firstRegisteredId`
 * rides along only when the first registration inside the thresholds is not the headline match,
 * and each match carries `firstRegistered` only when the answer names more than one passport.
 */
export function renderResult(result: MatchResult): unknown {
  return {
    exact: result.exact,
    best: result.best,
    matches: result.matches,
    confidence: result.confidence,
    queried: { ...result.queried, phash: result.queried.phash.toString() },
    ...(result.laterSameFingerprint === undefined ? {} : { laterSameFingerprint: result.laterSameFingerprint }),
    ...(result.firstRegisteredId === undefined ? {} : { firstRegisteredId: result.firstRegisteredId }),
  };
}

/** Renders the manifest for JSON, with the soft binding's pHash as a decimal string. */
export function renderManifest(manifest: ManifestSummary): unknown {
  if (manifest.softBinding === undefined) {
    return manifest;
  }
  return {
    ...manifest,
    softBinding: { ...manifest.softBinding, phash: manifest.softBinding.phash.toString() },
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
