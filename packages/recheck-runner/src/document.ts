import type { Fetcher } from "./net.js";

/** What the pinned document says, reduced to the things that decide whether a run happens. */
export interface Document {
  /** The `name` field, which is the only thing separating a picture from a seed test card. */
  title: string | null;
  /** True when the passport has no public picture: registered sealed and never published. */
  sealed: boolean;
  /**
   * True when the passport was registered sealed and its holder has published the picture since.
   * The document on chain cannot be rewritten, so only the unseal record beside it says so, and
   * such a passport is re-checked exactly like a public one.
   */
  unsealed: boolean;
  /** False when no gateway gave a document this could read. */
  readable: boolean;
  /**
   * True when the document passes privatelyRecheckable: sealed, a private re-check asked for, and
   * no picture named. Such a passport is routed to the sealed workflow while its private copy is
   * kept. The document never changes, so this says nothing about whether the copy still exists.
   */
  privateRecheck: boolean;
  /**
   * The content id of the picture the public workflow would fetch for this document, or null when
   * it names none it would fetch. The unseal record fills it in for a sealed passport published since.
   */
  picture: string | null;
  /**
   * Why no run could ever succeed on this document, when that is certain before any spend: the
   * runner's own fetch rule (R7) refused its address or its size, it is not a JSON object, or the
   * public workflow's picture rule refuses it. Names no address. Absent when the gateway simply did
   * not answer, which may change by the next pass.
   */
  refused?: string;
}

/**
 * The titles the scripts in packages/agents write when they put a test picture on the registry:
 * `Moolam seed 4` from scripts/seed.ts, `Moolam prove-it 2026-09-09T...` from scripts/prove.ts and
 * `Moolam Privy proof, the edit` from scripts/prove-privy.ts. Kept in step with the same rule in
 * packages/web/components/explore/sort.ts, which is what a judge sees on Explore.
 */
const TEST_TITLE = /^moolam (seed|prove-it|privy proof)\b/i;

const JSON_DATA_URI = "data:application/json,";
const TIMEOUT_MS = 10_000;
const PASSPORT_ID = /^0x[0-9a-f]{64}$/;

/**
 * The same cap as packages/workflow/moolam-verifier/pinned.ts. A Moolam metadata document is under
 * 2 KB (the prove-it passport's is 875 bytes), so this only stops a document registered outside
 * Moolam from making the runner hold something large.
 */
export const MAX_DOCUMENT_BYTES = 32_000;

/**
 * What the verify service's GET /unseal/{passportId} said. "failed" is kept apart from "none" on
 * purpose: a service that could not answer says nothing about the passport, so it must never be read
 * as "still sealed" (refused for good) nor as "published" (a report spent on a guess).
 */
export type RecordLookup =
  | {
      kind: "found";
      /** The thumbnail's content id as the workflow reads it off the record, or null when it reads none. */
      picture: string | null;
    }
  | { kind: "none" }
  | { kind: "mismatch" }
  | { kind: "failed"; reason: string };

/**
 * Whether this is one of the seed test cards.
 *
 * A document with no title counts as one. The sweep is about giving a judge's own picture a
 * verdict, and a record nobody can read the title of is not the picture to spend a report on.
 */
export function isTestCard(title: string | null): boolean {
  const clean = (title ?? "").trim();
  return clean === "" || TEST_TITLE.test(clean);
}

/** A picture worth sweeping: readable, not a seed card, not sealed, and one the workflow would fetch. */
export function isRealPicture(document: Document): boolean {
  return document.readable && !document.sealed && document.refused === undefined && !isTestCard(document.title);
}

/**
 * One passport's pinned document.
 *
 * A passport either names a JSON file on IPFS or carries the document inline as a data URI, and
 * both are read, because this has to work with whatever the creator's app wrote on chain. The
 * inline one makes no request at all. A fetched one is `ipfs://<cid>` through the configured
 * gateway and nothing else: an http(s) address a registrant wrote is refused before any request,
 * a redirect is an error rather than followed, and the body is read no further than the byte cap.
 * A gateway that says nothing leaves `readable` false, which keeps the passport out of the sweep
 * this pass instead of spending a report on a record nobody can check.
 */
export async function readDocument(
  metadataURI: string,
  gateway: string,
  fetcher: Fetcher = fetch,
): Promise<Document> {
  const unreadable: Document = { title: null, sealed: false, unsealed: false, readable: false, privateRecheck: false, picture: null };
  const notJson: Document = { ...unreadable, refused: "its metadata document is not a JSON object" };

  let text: string;
  if (metadataURI.startsWith(JSON_DATA_URI)) {
    try {
      text = decodeURIComponent(metadataURI.slice(JSON_DATA_URI.length));
    } catch {
      return notJson;
    }
  } else {
    const url = fetchUrl(gateway, metadataURI);
    if (url === null) {
      return { ...unreadable, refused: "its metadata address is not an IPFS content id, so the runner does not fetch it" };
    }
    try {
      const response = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!response.ok) {
        return unreadable;
      }
      const body = await cappedText(response, MAX_DOCUMENT_BYTES);
      if (body === null) {
        return { ...unreadable, refused: `its metadata document is over the ${MAX_DOCUMENT_BYTES} byte cap` };
      }
      text = body;
    } catch {
      return unreadable;
    }
  }

  // A body the gateway did hand over and that does not parse is the document itself, not a miss:
  // the workflow parses the same bytes and would refuse them the same way.
  try {
    return describe(JSON.parse(text) as unknown);
  } catch {
    return notJson;
  }
}

/**
 * The document reduced to a title and a seal.
 *
 * A document that claims sealed and still names a picture is read as published, the same way the
 * passport page reads it: the picture is pinned, so it is already public, and treating it as
 * sealed would hide something that is not hidden.
 */
export function describe(parsed: unknown): Document {
  if (typeof parsed !== "object" || parsed === null) {
    return {
      title: null,
      sealed: false,
      unsealed: false,
      readable: false,
      privateRecheck: false,
      picture: null,
      refused: "its metadata document is not a JSON object",
    };
  }
  const record = parsed as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name : null;
  const named = uriOf(record.thumbnail) ?? uriOf(record.image);
  const rule = pictureRule(record);

  return {
    title: name,
    sealed: record.sealed === true && named === null,
    unsealed: false,
    readable: true,
    privateRecheck: privatelyRecheckable(parsed),
    picture: rule.kind === "fetch" ? rule.cid : null,
    ...(rule.kind === "refused" ? { refused: rule.reason } : {}),
  };
}

export type PictureRule = { kind: "fetch"; cid: string } | { kind: "ask-record" } | { kind: "refused"; reason: string };

/**
 * The public workflow's picture rule, choosePicture in packages/workflow/moolam-verifier/picture.ts,
 * up to where it would ask for the unseal record: the document's `thumbnail ?? image` when that is
 * a non-empty string, which must then be `ipfs://<cid>`; otherwise a sealed document naming neither
 * goes to the record; anything else names no picture. Copied rather than imported because that file
 * lives outside this package's build, and held to the original's answers over a table of documents
 * by test/workflow-picture.test.ts. The reasons name no address.
 */
export function pictureRule(document: Record<string, unknown>): PictureRule {
  const reference = document.thumbnail ?? document.image;
  if (typeof reference === "string" && reference.length > 0) {
    const cid = pinnedContentId(reference);
    return cid === null
      ? { kind: "refused", reason: "its metadata names a picture that is not an IPFS content id, which the workflow refuses" }
      : { kind: "fetch", cid };
  }
  const sealedWithoutPicture = document.sealed === true && document.thumbnail == null && document.image == null;
  return sealedWithoutPicture
    ? { kind: "ask-record" }
    : { kind: "refused", reason: "its metadata names no thumbnail or image to check" };
}

/**
 * Whether a metadata document asks for a private re-check and leaves nothing public to re-check.
 *
 * A byte for byte copy of the verify service's predicate in packages/verifier/src/sealed.ts and of
 * the sealed workflow's in packages/workflow/moolam-sealed-verifier/private-copy.ts, held to both
 * by test/sealed-private-copy.test.ts and run against the service's shared fixture set, so the
 * queue, this runner and the workflow cannot disagree about a document.
 */
export function privatelyRecheckable(document: unknown): boolean {
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return false;
  }
  const fields = document as Record<string, unknown>;
  return (
    fields.sealed === true &&
    fields.privateRecheck === true &&
    !Object.hasOwn(fields, "image") &&
    !Object.hasOwn(fields, "thumbnail")
  );
}

/**
 * The third kind: a sealed document whose unseal record exists is a published picture. Anything
 * short of a found record leaves the document as it was, and the runner deals with "failed" and
 * "mismatch" before it gets here.
 */
export function withRecord(document: Document, record: RecordLookup): Document {
  if (!document.sealed || record.kind !== "found") {
    return document;
  }
  return { ...document, sealed: false, unsealed: true, picture: record.picture };
}

/**
 * The one rule for comparing passport ids, used on both the id the runner holds and the id the
 * record names, so letter case can neither pass a mismatch nor fail a match.
 */
export function passportKey(value: string): string {
  return value.toLowerCase();
}

/**
 * Asks the verify service whether a sealed passport's picture has been published since.
 *
 * A 404 is the service saying there is no record. Every other failure, a status that is neither 200
 * nor 404, a timeout, a body that is not JSON or names no passport, is "failed" with a reason that
 * names the status and never the URL. A record about another passport is "mismatch", which the
 * runner refuses rather than retries.
 */
export async function readUnsealRecord(
  serviceUrl: string,
  passportId: string,
  fetcher: Fetcher = fetch,
): Promise<RecordLookup> {
  const id = passportKey(passportId);
  if (!PASSPORT_ID.test(id)) {
    return { kind: "failed", reason: "the passport id is not 32 bytes of hex" };
  }

  let response: Response;
  try {
    response = await fetcher(`${serviceUrl}/unseal/${id}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return {
      kind: "failed",
      reason: timedOut
        ? `the unseal record lookup did not answer within ${TIMEOUT_MS / 1000} seconds`
        : "the unseal record lookup could not reach the verify service",
    };
  }

  if (response.status === 404) {
    return { kind: "none" };
  }
  if (response.status !== 200) {
    return { kind: "failed", reason: `the unseal record lookup answered status ${response.status}` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: "failed", reason: "the unseal record lookup answered status 200 with a body that is not JSON" };
  }
  const answer = typeof body === "object" && body !== null ? (body as { passportId?: unknown; thumbnail?: unknown }) : {};
  if (typeof answer.passportId !== "string") {
    return { kind: "failed", reason: "the unseal record lookup answered status 200 with no passport id" };
  }
  return passportKey(answer.passportId) === id ? { kind: "found", picture: recordPicture(answer.thumbnail) } : { kind: "mismatch" };
}

/**
 * The record's thumbnail content id, read the way the workflow's recordThumbnail in picture.ts reads
 * it: the uri must be `ipfs://<cid>` and nothing else, and a cid field, when present, must be that
 * same id. Held to the workflow's answers by test/workflow-picture.test.ts.
 */
export function recordPicture(value: unknown): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const thumbnail = value as Record<string, unknown>;
  const cid = pinnedContentId(thumbnail.uri);
  if (cid === null) {
    return null;
  }
  if (thumbnail.cid !== undefined && thumbnail.cid !== cid) {
    return null;
  }
  return cid;
}

/**
 * Whether the document names a picture at all. Deliberately wider than pinnedContentId: this only
 * decides sealed or published, as the passport page reads it, and fetches nothing. Whether the
 * picture is pinned content is the workflow's rule, applied before it fetches.
 */
function uriOf(value: unknown): string | null {
  return typeof value === "string" && /^(ipfs:\/\/|https?:\/\/)/.test(value) ? value : null;
}

/**
 * The content id in `ipfs://<cid>`, or null for anything else.
 *
 * A byte for byte copy of the workflows' predicate in packages/workflow/moolam-verifier/pinned.ts,
 * held to it by test/workflow-picture.test.ts, so the runner and both workflows refuse exactly the
 * same addresses. It is copied rather than imported because that file lives outside this package's
 * build. What it covers and what it does not is written beside the original.
 */
export function pinnedContentId(reference: unknown): string | null {
  if (typeof reference !== "string" || !reference.startsWith("ipfs://")) {
    return null;
  }
  const cid = reference.slice("ipfs://".length);
  return /^[A-Za-z0-9]+$/.test(cid) ? cid : null;
}

/** The gateway URL for `ipfs://<cid>`, or null for every other address, http(s) included. */
export function fetchUrl(gateway: string, reference: string): string | null {
  const cid = pinnedContentId(reference);
  if (cid === null) {
    return null;
  }
  return `${gateway.endsWith("/") ? gateway : `${gateway}/`}${cid}`;
}

/**
 * The body as text, or null when it is longer than `cap` bytes. A declared length over the cap is
 * refused without reading, and otherwise reading stops at the first chunk past the cap, so a body
 * that lies about its length or never ends is never held whole.
 */
export async function cappedText(response: Response, cap: number): Promise<string | null> {
  const bytes = await cappedBytes(response, cap);
  return bytes === null ? null : new TextDecoder().decode(bytes);
}

/** The body's bytes under the same rule as cappedText. */
export async function cappedBytes(response: Response, cap: number): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > cap) {
    await response.body?.cancel();
    return null;
  }
  if (response.body === null) {
    return new Uint8Array(0);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    length += value.byteLength;
    if (length > cap) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/**
 * The same cap as MAX_PICTURE_BYTES in packages/workflow/moolam-verifier/pinned.ts, held to it by
 * test/workflow-picture.test.ts. The workflow refuses a picture over it before decoding a byte.
 */
export const MAX_PICTURE_BYTES = 60_000;

/**
 * What the runner learned by reading a passport's picture before paying for a run (tally R12).
 * "refused" is certain: the workflow would refuse the same bytes. "missed" is a gateway that did not
 * hand them over, which may change. "unsized" is a JPEG whose size this reader did not find, which
 * is left to the workflow rather than refused on a guess.
 */
export type PictureRead =
  | { kind: "ok"; width: number; height: number }
  | { kind: "unsized" }
  | { kind: "refused"; reason: string }
  | { kind: "missed"; reason: string };

/**
 * Reads the picture the public workflow would fetch, under the workflow's own rules: `ipfs://<cid>`
 * through the configured gateway, redirects refused, nothing but a 200 read, the body cut off past
 * the byte cap. The caller then checks the size, so a picture the fingerprint cannot take is settled
 * for nothing instead of on chain for a report. Reasons name no address.
 */
export async function readPicture(cid: string, gateway: string, fetcher: Fetcher = fetch): Promise<PictureRead> {
  const url = fetchUrl(gateway, `ipfs://${cid}`);
  if (url === null) {
    return { kind: "refused", reason: "its picture is not an IPFS content id, which the workflow refuses" };
  }
  let bytes: Uint8Array | null;
  try {
    const response = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (response.status !== 200) {
      await response.body?.cancel();
      return { kind: "missed", reason: `the gateway answered status ${response.status} for its picture` };
    }
    bytes = await cappedBytes(response, MAX_PICTURE_BYTES);
  } catch {
    return { kind: "missed", reason: "the gateway did not hand over its picture" };
  }
  if (bytes === null) {
    return { kind: "refused", reason: `its picture is over the ${MAX_PICTURE_BYTES} byte cap the workflow holds pictures to` };
  }
  if (!isJpeg(bytes)) {
    return { kind: "refused", reason: "its picture is not a JPEG, the only kind the workflow decodes" };
  }
  const size = jpegSize(bytes);
  return size === null ? { kind: "unsized" } : { kind: "ok", ...size };
}

/** The two bytes every JPEG starts with. The workflow's decoder refuses anything else outright. */
function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

/**
 * A JPEG's width and height from its frame header, read the way the workflow's decoder (jpeg-js
 * 0.4.4) reads them: segments walked from the start, and only the three frame kinds it decodes,
 * baseline, extended and progressive, taken. Null when the bytes are not a JPEG or no such frame
 * header comes before the image data; null means "not known", never "too small".
 */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (!isJpeg(bytes)) {
    return null;
  }
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) {
      return null;
    }
    const marker = bytes[at + 1] ?? 0;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) {
      return null;
    }
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (at + 9 > bytes.length) {
        return null;
      }
      const height = ((bytes[at + 5] ?? 0) << 8) | (bytes[at + 6] ?? 0);
      const width = ((bytes[at + 7] ?? 0) << 8) | (bytes[at + 8] ?? 0);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    const length = ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0);
    if (length < 2) {
      return null;
    }
    at += 2 + length;
  }
  return null;
}

/** The side the fingerprint's grid needs, SAMPLE_SIZE in the workflow's phash.ts. */
const SAMPLE_SIZE = 32;

/**
 * Why a picture this size cannot be fingerprinted, or null when it can. A byte for byte copy of
 * the function in packages/workflow/moolam-verifier/phash.ts that perceptualHash throws with, held
 * to that text and to its answers by test/workflow-picture.test.ts. What it covers is written
 * beside the original.
 */
export function fingerprintSizeRefusal(width: number, height: number): string | null {
  if (width < SAMPLE_SIZE || height < SAMPLE_SIZE) {
    return `image is ${width}x${height}, too small to fingerprint`;
  }
  return null;
}
