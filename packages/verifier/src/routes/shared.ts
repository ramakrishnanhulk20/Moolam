import { subscribe, tracingChannel } from "node:diagnostics_channel";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Writable } from "node:stream";
import type { MultipartValue } from "@fastify/multipart";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { manifestUnreadable, readManifest, type ManifestSummary } from "../c2pa.js";
import { FETCH_TIMEOUT_MS, MAX_UPLOAD_BYTES } from "../env.js";
import { ImageTooLarge, UndecodableImage, UnsupportedImageFormat } from "../fingerprint.js";
import { Busy } from "../generate/gate.js";
import { rateLimitKey } from "../limits/addressKey.js";
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
 * The upload bytes every request together may hold in memory at once: ten full uploads, 200 MiB.
 *
 * Measured on 2026-09-26: Railway gives this service 8 GB and it ran at 240 MB on average with a
 * 290 MB peak. One 40 MP picture's blockhash decode adds about 383 MB (review pass 8, intake 1),
 * and the match gate runs three decodes at most, so a full gate is about 1.15 GB. A held upload is
 * copied at least once more on its way through (the blockhash worker's copy, sharp's input), so
 * 200 MiB of bodies costs about 420 MB at worst. 290 MB, 1.15 GB and 420 MB together stay under
 * the 2 GB DEPLOY.md asks for. Without a ceiling every caller parked behind the match gate kept its
 * whole body, 20 MB each, and 30 of them outgrew the host (review pass 7, V62).
 */
export const UPLOAD_CEILING_BYTES = 10 * MAX_UPLOAD_BYTES;

/**
 * What one rate-limit key may hold of the ceiling at once: two full uploads, 40 MiB. Without it
 * three idle uploads from one address held the whole ceiling and every other upload was refused
 * busy (review pass 8, V70). Two, not one, so a browser that sends a verify while a registration
 * is still uploading is not refused.
 */
export const CALLER_CEILING_BYTES = 2 * MAX_UPLOAD_BYTES;

/**
 * What the ceilings allow and what requests hold now. The limits are fields so a test can lower
 * them.
 */
export const heldUploads = { limit: UPLOAD_CEILING_BYTES, perCaller: CALLER_CEILING_BYTES, held: 0 };

/** What each rate-limit key holds now. A key holding nothing has no entry. */
const heldByCaller = new Map<string, number>();

/** Past the ceiling. It carries 503, so every upload route answers it as its one word, busy. */
export class UploadsBusy extends Error {
  readonly statusCode = 503;
  constructor() {
    super("busy");
    this.name = "UploadsBusy";
  }
}

/**
 * The caller hung up before the route could use their upload, so it is not read, fetched or queued
 * any further. It carries 499, the status /edit already answers a caller who left with, and the
 * answer reaches nobody.
 */
export class CallerGone extends Error {
  readonly statusCode = 499;
  constructor() {
    super("client-gone");
    this.name = "CallerGone";
  }
}

/**
 * What one request holds of the ceilings: every upload byte it has received and not given back.
 * The count grows chunk by chunk as the bytes arrive and comes back in one piece when the route's
 * handler has finished, because until then the handler may still hold the bytes, however the
 * caller left (review pass 9, V78, V79 and V90).
 */
interface UploadAccount {
  /** The rate-limit key of the caller, which the per-caller ceiling and the match gate both count on. */
  caller: string;
  /** The response Node made for this request, which says whether the caller is still there. */
  response: ServerResponse;
  held: number;
  /** True once the handler has finished. Nothing is counted after that. */
  closed: boolean;
}

/**
 * The response Node made for each request, so a route can tell whether its caller is still there.
 * Fastify's request has no link to its reply, and the request stream is no guide: Node closes it as
 * soon as its body is read. Node publishes every response it creates on this channel, the test
 * harness's inject() included.
 */
const responses = new WeakMap<IncomingMessage, ServerResponse>();
subscribe("http.server.response.created", (message) => {
  const { request, response } = message as { request: IncomingMessage; response: ServerResponse };
  responses.set(request, response);
});

const accounts = new WeakMap<IncomingMessage, UploadAccount>();

/** The account each body readUpload, readFromUrl or underUploadCeiling handed back was counted in, for verifyBytes and studioTurn. */
const accountOfBytes = new WeakMap<Buffer, UploadAccount>();

/**
 * Gives every request's upload bytes back once its route handler has returned or thrown. The routes
 * that read uploads also do it in their own finally (givesUploadsBack or, on /verify, a finally of
 * its own); this is the backstop for a route added later that forgets to, so no share outlives its
 * handler. Fastify publishes the end of every handler on this channel, the test harness's inject()
 * included.
 */
tracingChannel<{ request: FastifyRequest; async?: boolean }>("fastify.request.handler").subscribe({
  start: () => undefined,
  asyncStart: () => undefined,
  error: () => undefined,
  end: (store) => {
    if (store.async !== true) {
      giveBackRaw(store.request.raw);
    }
  },
  asyncEnd: (store) => {
    giveBackRaw(store.request.raw);
  },
});

/**
 * Whether the caller has hung up: the connection closed before the answer was sent. Once the answer
 * is sent the caller has been served, whatever the socket does next.
 */
function hasLeft(raw: IncomingMessage, response: ServerResponse): boolean {
  return !response.writableFinished && (response.destroyed || raw.socket?.destroyed === true);
}

/** Whether this request's caller has hung up. A request whose response this process never saw counts as present. */
function callerLeft(request: FastifyRequest): boolean {
  const response = responses.get(request.raw);
  return response !== undefined && hasLeft(request.raw, response);
}

/**
 * The account this request's upload bytes are counted in, opened on the first read.
 *
 * Throws CallerGone for a caller who has already hung up, so nothing of their body is read, and
 * ServiceFault for a request whose response this process cannot watch or whose handler has already
 * finished, since bytes counted where nothing gives them back would shut the door on everyone.
 */
function openAccount(request: FastifyRequest): UploadAccount {
  const response = responses.get(request.raw);
  if (response === undefined) {
    throw new ServiceFault("this request has no response the upload ceiling can watch");
  }
  if (hasLeft(request.raw, response)) {
    throw new CallerGone();
  }
  const open = accounts.get(request.raw);
  if (open?.closed === true) {
    throw new ServiceFault("this request's handler has already finished");
  }
  if (open !== undefined) {
    return open;
  }
  const account: UploadAccount = { caller: rateLimitKey(request.ip), response, held: 0, closed: false };
  accounts.set(request.raw, account);
  return account;
}

/**
 * Counts `bytes` more for this account, against the ceiling for everyone and the ceiling for its
 * caller's rate-limit key, so one address cannot hold the room every other caller needs.
 *
 * Throws UploadsBusy, counting nothing, when either ceiling would be passed.
 */
function take(account: UploadAccount, bytes: number): void {
  const callerHeld = heldByCaller.get(account.caller) ?? 0;
  if (heldUploads.held + bytes > heldUploads.limit || callerHeld + bytes > heldUploads.perCaller) {
    throw new UploadsBusy();
  }
  heldUploads.held += bytes;
  heldByCaller.set(account.caller, callerHeld + bytes);
  account.held += bytes;
}

/** Takes `bytes` off this account and both counts. */
function release(account: UploadAccount, bytes: number): void {
  const given = Math.min(bytes, account.held);
  account.held -= given;
  heldUploads.held -= given;
  const left = (heldByCaller.get(account.caller) ?? 0) - given;
  if (left > 0) {
    heldByCaller.set(account.caller, left);
  } else {
    heldByCaller.delete(account.caller);
  }
}

function giveBackRaw(raw: IncomingMessage): void {
  const account = accounts.get(raw);
  if (account === undefined || account.closed) {
    return;
  }
  account.closed = true;
  release(account, account.held);
}

/**
 * Gives back every upload byte this request holds of the ceilings. Only a route handler that has
 * finished with the bytes calls it, in its own finally; calling it twice does nothing.
 */
export function giveBackUploads(request: FastifyRequest): void {
  giveBackRaw(request.raw);
}

/**
 * Wraps a route handler so the upload bytes its request holds come back when it returns or throws,
 * and never earlier: a caller who hangs up leaves the bytes in the handler's hands until then.
 */
export function givesUploadsBack<Rest extends unknown[], Result>(
  handler: (request: FastifyRequest, ...rest: Rest) => Promise<Result>,
): (request: FastifyRequest, ...rest: Rest) => Promise<Result> {
  return async (request, ...rest) => {
    try {
      return await handler(request, ...rest);
    } finally {
      giveBackUploads(request);
    }
  };
}

/**
 * Once a read is done, keeps counting only the file it handed back: the multipart boundaries and
 * text fields the count also saw are gone by then. Records which account the file is counted in.
 */
function settle(account: UploadAccount, counted: number, bytes: Buffer): void {
  if (counted > bytes.length) {
    release(account, counted - bytes.length);
  }
  accountOfBytes.set(bytes, account);
}

/**
 * Runs a multipart reader while counting the request body as it arrives, chunk by chunk, before
 * the reader sees it. The moment a chunk would pass either ceiling the body is abandoned: the parser
 * is torn down with what it had buffered, the rest of the body is read off the wire and dropped, and
 * this throws UploadsBusy. A caller who hangs up part way through gets CallerGone the same way.
 *
 * A body also carries its multipart boundaries and short text fields, so it counts at most the
 * upload cap: the file limit refuses anything past that, and two full uploads from one caller must
 * still fit their share. Answers what `read` answered and how many bytes it counted.
 */
async function readCounted<T>(
  request: FastifyRequest,
  account: UploadAccount,
  read: () => Promise<T>,
): Promise<{ value: T; counted: number }> {
  const raw = request.raw;
  let counted = 0;
  let parser: Writable | undefined;
  let refuse: (error: Error) => void = () => undefined;
  const refused = new Promise<never>((_resolve, reject) => {
    refuse = reject;
  });

  // The multipart plugin pipes the request into its parser. Holding on to that parser is what lets
  // an abandoned body take the parser's buffered part of the file with it.
  const ownPipe = Object.prototype.hasOwnProperty.call(raw, "pipe");
  const pipe = raw.pipe;
  raw.pipe = function <Destination extends NodeJS.WritableStream>(destination: Destination, options?: { end?: boolean }) {
    parser = destination as unknown as Writable;
    return pipe.call(this, destination, options) as Destination;
  };

  const stop = (): void => {
    raw.removeListener("data", onData);
    account.response.removeListener("close", onClose);
    if (ownPipe) {
      raw.pipe = pipe;
    } else {
      delete (raw as { pipe?: unknown }).pipe;
    }
  };
  const abandon = (error: Error): void => {
    stop();
    if (parser !== undefined) {
      raw.unpipe(parser);
      parser.destroy(error);
    }
    raw.resume();
    refuse(error);
  };
  const onData = (chunk: Buffer): void => {
    const counts = Math.min(chunk.length, Math.max(0, MAX_UPLOAD_BYTES - counted));
    try {
      take(account, counts);
      counted += counts;
    } catch (error) {
      abandon(error as Error);
    }
  };
  const onClose = (): void => {
    if (!account.response.writableFinished) {
      abandon(new CallerGone());
    }
  };

  // Put in front, so the count sees each chunk before the parser does. prependListener does not
  // start the stream flowing the way on("data") would, so no byte can pass before the parser is
  // there to take it.
  raw.prependListener("data", onData);
  account.response.once("close", onClose);
  try {
    const value = await Promise.race([read(), refused]);
    return { value, counted };
  } finally {
    stop();
  }
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
 * Reads the image out of a multipart upload, counting the body against the upload ceilings as it
 * arrives. Once the file is in, only the file stays counted, until the handler gives it back.
 *
 * Throws CallerGone (499) for a caller who has hung up, before a byte is read or part way through,
 * UploadsBusy (503) the moment the body would pass either ceiling, and BadRequest when the request
 * carries no file part, when the part is not named "file", when the file is empty, or when it is
 * over the byte limit (413).
 */
export async function readUpload(request: FastifyRequest): Promise<Buffer> {
  if (!request.isMultipart()) {
    throw new BadRequest('send the image in a multipart field named "file"');
  }

  const account = openAccount(request);
  const { value: bytes, counted } = await readCounted(request, account, async () => {
    const part = await request.file({ limits: { fileSize: MAX_UPLOAD_BYTES } });
    if (part === undefined) {
      throw new BadRequest('send the image in a multipart field named "file"');
    }
    if (part.fieldname !== "file") {
      throw new BadRequest(`expected a multipart field named "file", got "${part.fieldname}"`);
    }

    let file: Buffer;
    try {
      file = await part.toBuffer();
    } catch (error) {
      if ((error as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
        throw new BadRequest(`the image is larger than the ${MAX_UPLOAD_BYTES} byte limit`, 413);
      }
      throw error;
    }

    if (file.length === 0) {
      throw new BadRequest("the uploaded file is empty");
    }
    return file;
  });
  settle(account, counted, bytes);
  return bytes;
}

/**
 * Runs a studio route's multipart reader under the upload ceilings, as readUpload runs its own:
 * the body is counted as it arrives, and once `read` is done only the file stays counted, until the
 * route's handler gives it back. /prepare, /edit and /unseal used to buffer whole uploads outside
 * the ceiling while they waited on the gate (review pass 8, V69).
 *
 * Throws CallerGone (499) for a caller who has hung up, without calling `read` when they left
 * before it, UploadsBusy (503) the moment the body would pass either ceiling, and whatever `read`
 * throws.
 */
export async function underUploadCeiling<T extends { bytes: Buffer }>(
  request: FastifyRequest,
  read: () => Promise<T>,
): Promise<T> {
  const account = openAccount(request);
  const { value: upload, counted } = await readCounted(request, account, read);
  settle(account, counted, upload.bytes);
  return upload;
}

/**
 * Runs a studio route's picture work, from /prepare, /edit or /unseal, in the gate's studio lane.
 *
 * The turn is taken under the caller's rate-limit key, so one caller holds one studio turn at a
 * time while other callers go ahead of its second request, as verifyBytes does for verifies. A
 * caller who has hung up is not queued at all.
 *
 * Throws CallerGone (499) when the caller has left, before the turn is queued or while it waited,
 * Busy when no turn came free in time, and whatever `task` throws.
 */
export async function studioTurn<T>(
  app: FastifyInstance,
  request: FastifyRequest,
  bytes: Buffer,
  task: () => Promise<T>,
): Promise<T> {
  if (callerLeft(request)) {
    throw new CallerGone();
  }
  return await app.verifier.runPrepare(task, accountOfBytes.get(bytes)?.caller ?? rateLimitKey(request.ip), () =>
    callerLeft(request) ? new CallerGone() : undefined,
  );
}

/**
 * Fetches a remote image within the timeout and the size cap.
 *
 * The address guard and the redirect chain live in src/net/safeFetch.ts. The
 * body is read chunk by chunk and abandoned the moment it crosses the cap,
 * because a Content-Length header is a claim by the remote server, not a fact.
 *
 * The body counts against the upload ceilings chunk by chunk as it arrives,
 * exactly as an upload does, and the fetch is abandoned the moment a chunk
 * would pass either ceiling or run past the length the host declared. A caller
 * who hangs up stops the fetch at once, whether it is still waiting for the host
 * or part way through the body, and the bytes read so far stay counted until the
 * handler gives them back.
 *
 * Throws CallerGone (499) for a caller who has hung up, UploadsBusy (503) past
 * either ceiling, and BadRequest: 400 for a body that is not { "url": "..." },
 * 403 for a URL that points inside our own network, 413 over the byte limit, 502
 * when the remote host does not answer, fails part way through the body, or
 * sends more than it declared.
 */
export async function readFromUrl(request: FastifyRequest): Promise<Buffer> {
  const parsed = urlBodySchema.safeParse(request.body);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => issue.message).join("; ");
    throw new BadRequest(`send a multipart "file" field or a JSON body of { "url": "..." }: ${detail}`);
  }

  const account = openAccount(request);
  // safeFetch takes no signal of its own, so a caller who leaves while the host is still answering
  // is let go at once, and the answer that turns up later has its body dropped unread.
  const fetching = safeFetch(new URL(parsed.data.url), { timeoutMs: FETCH_TIMEOUT_MS });
  let response: Response;
  try {
    response = await unlessCallerLeaves(account, fetching);
  } catch (error) {
    if (error instanceof CallerGone) {
      fetching.then((late) => late.body?.cancel(), () => undefined).catch(() => undefined);
      throw error;
    }
    if (error instanceof BlockedTarget || error instanceof UnreachableTarget) {
      throw new BadRequest(error.message, error.statusCode);
    }
    throw error;
  }

  if (!response.ok || response.body === null) {
    await response.body?.cancel().catch(() => undefined);
    throw new BadRequest(`fetching ${parsed.data.url} returned ${response.status}`, 502);
  }

  // A compressed body arrives larger than its Content-Length says, so only a body sent as it is
  // is held to the length it declares.
  const encoded = (response.headers.get("content-encoding") ?? "identity") !== "identity";
  const declaredText = encoded ? null : response.headers.get("content-length");
  const declared = declaredText !== null && /^[0-9]+$/.test(declaredText) ? Number(declaredText) : undefined;

  const reader = response.body.getReader();
  let left = false;
  const onClose = (): void => {
    if (!account.response.writableFinished) {
      left = true;
      reader.cancel().catch(() => undefined);
    }
  };
  account.response.once("close", onClose);

  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      let next: Awaited<ReturnType<typeof reader.read>>;
      try {
        next = await reader.read();
      } catch (error) {
        if (left) {
          throw new CallerGone();
        }
        // A body that stalls past the timeout or a connection the remote drops mid-body is the
        // remote host failing, not the caller, so a client that retries a 5xx gets to retry it.
        throw new BadRequest(`fetching ${parsed.data.url} failed part way through: ${safeReason(error)}`, 502);
      }
      if (left) {
        throw new CallerGone();
      }
      if (next.done) {
        break;
      }
      total += next.value.byteLength;
      if (total > MAX_UPLOAD_BYTES) {
        throw new BadRequest(`the image at ${parsed.data.url} is larger than the ${MAX_UPLOAD_BYTES} byte limit`, 413);
      }
      if (declared !== undefined && total > declared) {
        throw new BadRequest(`the host of ${parsed.data.url} sent more than the ${declared} bytes it declared`, 502);
      }
      take(account, next.value.byteLength);
      chunks.push(Buffer.from(next.value));
    }
  } catch (error) {
    reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    account.response.removeListener("close", onClose);
  }

  if (total === 0) {
    throw new BadRequest(`the image at ${parsed.data.url} is empty`);
  }
  const bytes = Buffer.concat(chunks);
  settle(account, total, bytes);
  return bytes;
}

/**
 * Waits for `work`, or throws CallerGone the moment this account's caller hangs up, whichever
 * comes first. Throws CallerGone at once for a caller already gone.
 */
async function unlessCallerLeaves<T>(account: UploadAccount, work: Promise<T>): Promise<T> {
  let onClose: () => void = () => undefined;
  const leaves = new Promise<never>((_resolve, reject) => {
    onClose = () => {
      if (!account.response.writableFinished) {
        reject(new CallerGone());
      }
    };
  });
  if (account.response.destroyed && !account.response.writableFinished) {
    onClose();
  }
  account.response.once("close", onClose);
  try {
    return await Promise.race([work, leaves]);
  } finally {
    account.response.removeListener("close", onClose);
  }
}

/** What a caller is told when this service, not their picture, failed while matching. */
export const SERVICE_FAULT_REASON = "the service could not read this picture right now, try again";

/**
 * Matches an image against the registry and reads any manifest it carries, in
 * the JSON shape both routes answer with.
 *
 * The manifest read and the match each run in a verify slot of the service's
 * concurrency gate, the manifest first because it is the cheaper of the two to
 * throw away when the gate turns the request down, so a burst of large uploads
 * queues instead of reading and decoding all at once (review pass 7, V62). Both
 * run under the caller's rate-limit key, so one caller holds one slot at a time
 * (review pass 8, V74). A caller who has hung up is not queued for either turn.
 *
 * Throws BadRequest: 413 when the image is over the pixel limit, 400 only when
 * the upload itself is at fault (not one of the three formats, or pixels the
 * decoders refused). Throws ServiceFault, 503 with SERVICE_FAULT_REASON, for
 * anything else, which is this service failing: a blockhash worker that stopped
 * or timed out, a hash of the wrong length, a decoder out of memory, or a
 * failure nobody named. That one is logged, because telling the caller to change
 * a file that is fine would hide it (review pass 6, answers 7). Throws Busy,
 * which carries 503, when no slot came free in time, and CallerGone (499) when
 * the caller left before a turn was joined or while it waited for one.
 */
export async function verifyBytes(
  app: FastifyInstance,
  bytes: Buffer,
): Promise<{ result: unknown; manifest: unknown }> {
  const account = accountOfBytes.get(bytes);
  const left = (): CallerGone | undefined =>
    account !== undefined && !account.closed && hasLeft(account.response.req, account.response)
      ? new CallerGone()
      : undefined;
  const refuseIfLeft = (): void => {
    const gone = left();
    if (gone !== undefined) {
      throw gone;
    }
  };
  let result: MatchResult;
  let manifest: ManifestSummary;
  try {
    refuseIfLeft();
    // readManifest promises never to throw. The catch is for the day it breaks that promise: a
    // manifest problem may cost the answer its manifest, never the match.
    manifest = await app.verifier.runVerify(
      () => readManifest(bytes).catch(() => manifestUnreadable()),
      account?.caller,
      left,
    );
    refuseIfLeft();
    result = await app.verifier.runMatch(bytes, account?.caller, left);
  } catch (error) {
    if (error instanceof Busy || error instanceof CallerGone) {
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
