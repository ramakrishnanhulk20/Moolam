import { subscribe } from "node:diagnostics_channel";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { MultipartValue } from "@fastify/multipart";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { manifestUnreadable, readManifest, type ManifestSummary } from "../c2pa.js";
import { FETCH_TIMEOUT_MS, MAX_UPLOAD_BYTES } from "../env.js";
import { ImageTooLarge, UndecodableImage, UnsupportedImageFormat } from "../fingerprint.js";
import { Busy } from "../generate/gate.js";
import type { MatchResult } from "../match.js";
import { safeReason } from "../net/errorText.js";
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

/**
 * The upload bytes every request together may hold in memory at once: three full uploads, 60 MiB.
 * DEPLOY.md gives the host 512 MB and measured 72 MiB at idle, and the match gate lets two decodes
 * run at once at up to about 160 MB each (MAX_IMAGE_PIXELS), which leaves roughly 120 MB. A held
 * upload is copied at least once more on its way through (the blockhash worker's copy, sharp's
 * input), so 60 MiB of bodies is what that headroom can carry. Without it every caller parked
 * behind the match gate kept its whole body, 20 MB each, and 30 of them outgrew the host
 * (review pass 7, V62).
 */
export const UPLOAD_CEILING_BYTES = 3 * MAX_UPLOAD_BYTES;

/** What the ceiling allows and what requests hold now. The limit is a field so a test can lower it. */
export const heldUploads = { limit: UPLOAD_CEILING_BYTES, held: 0 };

/** Past the ceiling. It carries 503, so every upload route answers it as its one word, busy. */
export class UploadsBusy extends Error {
  readonly statusCode = 503;
  constructor() {
    super("busy");
    this.name = "UploadsBusy";
  }
}

/** One request's share of the ceiling, given back once its response is done and no match is using its bytes. */
interface UploadHold {
  share: number;
  answered: boolean;
  matching: number;
  returned: boolean;
}

/**
 * The response Node made for each request, so a share can be given back when that response closes.
 * Fastify's request has no link to its reply, and the request stream is no guide: Node closes it as
 * soon as its body is read. Node publishes every response it creates on this channel, the test
 * harness's inject() included.
 */
const responses = new WeakMap<IncomingMessage, ServerResponse>();
subscribe("http.server.response.created", (message) => {
  const { request, response } = message as { request: IncomingMessage; response: ServerResponse };
  responses.set(request, response);
});

/** The hold covering each body readUpload or readFromUrl handed back, found again by verifyBytes. */
const holds = new WeakMap<Buffer, UploadHold>();

/** The share a body takes: the length it declares when that is a whole number, capped at the upload cap, or the cap. */
function shareOf(declared: string | string[] | null | undefined): number {
  return typeof declared === "string" && /^[0-9]+$/.test(declared)
    ? Math.min(Number(declared), MAX_UPLOAD_BYTES)
    : MAX_UPLOAD_BYTES;
}

function giveBack(hold: UploadHold): void {
  if (hold.returned) {
    return;
  }
  hold.returned = true;
  heldUploads.held -= hold.share;
}

/**
 * Takes `share` bytes of the ceiling for this request before any of its body is read, and arranges
 * for them to come back when the response closes, however it closes: sent, refused, thrown or hung
 * up on. A caller who hangs up while verifyBytes is still using the bytes keeps them counted until
 * the match lets go, because the bytes are still in memory until then.
 *
 * Throws UploadsBusy past the ceiling, and ServiceFault for a request whose response this process
 * cannot watch, since a share nothing gives back would shut the door on everyone after it.
 */
function holdUpload(request: FastifyRequest, share: number): UploadHold {
  const response = responses.get(request.raw);
  if (response === undefined) {
    throw new ServiceFault("this request has no response the upload ceiling can watch");
  }
  if (heldUploads.held + share > heldUploads.limit) {
    throw new UploadsBusy();
  }
  heldUploads.held += share;
  const hold: UploadHold = { share, answered: false, matching: 0, returned: false };
  const answered = (): void => {
    hold.answered = true;
    if (hold.matching === 0) {
      giveBack(hold);
    }
  };
  if (response.destroyed || response.writableFinished || request.raw.socket?.destroyed === true) {
    answered();
  } else {
    response.once("close", answered);
  }
  return hold;
}

/**
 * The text of a multipart field, or BadRequest naming the field when it is anything else.
 *
 * @fastify/multipart parses a part sent as application/json and hands over a boolean, a number or
 * an object. Skipping that part turned sealed=true into a public prepare and dropped a training
 * statement without a word (review pass 7, V57), so every field loop asks here instead.
 */
export function textField(part: MultipartValue): string {
  if (typeof part.value !== "string") {
    throw new BadRequest(`the "${part.fieldname}" field must be sent as plain text, not as ${part.mimetype}`);
  }
  return part.value;
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
 * The request's share of the upload ceiling is taken first, at its Content-Length or at the upload
 * cap when it gives none, and nothing of the body is read when the share does not fit.
 *
 * Throws UploadsBusy (503) past the ceiling, and BadRequest when the request carries no file part,
 * when the part is not named "file", when the file is empty, or when it is over the byte limit (413).
 */
export async function readUpload(request: FastifyRequest): Promise<Buffer> {
  if (!request.isMultipart()) {
    throw new BadRequest('send the image in a multipart field named "file"');
  }

  const hold = holdUpload(request, shareOf(request.headers["content-length"]));
  try {
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
    holds.set(bytes, hold);
    return bytes;
  } catch (error) {
    giveBack(hold);
    throw error;
  }
}

/**
 * Fetches a remote image within the timeout and the size cap.
 *
 * The address guard and the redirect chain live in src/net/safeFetch.ts. The
 * body is read chunk by chunk and abandoned the moment it crosses the cap,
 * because a Content-Length header is a claim by the remote server, not a fact.
 *
 * The body's share of the upload ceiling is taken once the remote host has
 * answered and before a byte of its body is read: its Content-Length when it
 * sends the bytes as they are, the upload cap otherwise, and a body that runs
 * past the length it declared is abandoned.
 *
 * Throws UploadsBusy (503) past the ceiling, and BadRequest: 400 for a body that
 * is not { "url": "..." }, 403 for a URL that points inside our own network, 413
 * over the byte limit, 502 when the remote host does not answer, fails part way
 * through the body, or sends more than it declared.
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

  // A compressed body arrives larger than its Content-Length says, so only a body sent as it is
  // may be held at the length it declares.
  const encoded = (response.headers.get("content-encoding") ?? "identity") !== "identity";
  let hold: UploadHold;
  try {
    hold = holdUpload(request, encoded ? MAX_UPLOAD_BYTES : shareOf(response.headers.get("content-length")));
  } catch (error) {
    await response.body.cancel().catch(() => undefined);
    throw error;
  }

  try {
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        total += chunk.byteLength;
        if (total > MAX_UPLOAD_BYTES) {
          throw new BadRequest(`the image at ${parsed.data.url} is larger than the ${MAX_UPLOAD_BYTES} byte limit`, 413);
        }
        if (total > hold.share) {
          throw new BadRequest(`the host of ${parsed.data.url} sent more than the ${hold.share} bytes it declared`, 502);
        }
        chunks.push(Buffer.from(chunk));
      }
    } catch (error) {
      if (error instanceof BadRequest) {
        throw error;
      }
      // A body that stalls past the timeout or a connection the remote drops mid-body is the remote
      // host failing, not the caller, so a client that retries a 5xx gets to retry it.
      const reason = safeReason(error);
      throw new BadRequest(`fetching ${parsed.data.url} failed part way through: ${reason}`, 502);
    }

    if (total === 0) {
      throw new BadRequest(`the image at ${parsed.data.url} is empty`);
    }
    const bytes = Buffer.concat(chunks);
    holds.set(bytes, hold);
    return bytes;
  } catch (error) {
    giveBack(hold);
    throw error;
  }
}

/** What a caller is told when this service, not their picture, failed while matching. */
export const SERVICE_FAULT_REASON = "the service could not read this picture right now, try again";

/**
 * Matches an image against the registry and reads any manifest it carries, in
 * the JSON shape both routes answer with.
 *
 * The manifest read and the match each run in a slot of the service's
 * concurrency gate, the manifest first because it is the cheaper of the two to
 * throw away when the gate turns the request down, so a burst of large uploads
 * queues instead of reading and decoding all at once (review pass 7, V62). The
 * upload ceiling keeps counting the bytes for as long as this runs, even when
 * the caller has hung up.
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
  const hold = holds.get(bytes);
  if (hold !== undefined) {
    hold.matching += 1;
  }
  let result: MatchResult;
  let manifest: ManifestSummary;
  try {
    // readManifest promises never to throw. The catch is for the day it breaks that promise: a
    // manifest problem may cost the answer its manifest, never the match.
    manifest = await app.verifier.runPrepare(() => readManifest(bytes).catch(() => manifestUnreadable()));
    result = await app.verifier.runMatch(bytes);
  } catch (error) {
    if (error instanceof Busy) {
      throw error;
    }
    if (error instanceof ImageTooLarge) {
      throw new BadRequest(error.message, 413);
    }
    const detail = safeReason(error);
    if (error instanceof UnsupportedImageFormat || error instanceof UndecodableImage) {
      throw new BadRequest(`the upload is not an image we can read: ${detail}`);
    }
    app.log.error(
      { reason: detail, fault: error instanceof Error ? error.name : typeof error },
      "verify: the service failed while matching",
    );
    throw new ServiceFault(SERVICE_FAULT_REASON, { cause: error });
  } finally {
    if (hold !== undefined) {
      hold.matching -= 1;
      if (hold.answered && hold.matching === 0) {
        giveBack(hold);
      }
    }
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
