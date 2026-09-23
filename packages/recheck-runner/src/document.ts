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
}

/**
 * The titles the scripts in packages/agents write when they put a test picture on the registry:
 * `Moolam seed 4` from scripts/seed.ts, `Moolam prove-it 2026-09-09T...` from scripts/prove.ts and
 * `Moolam Privy proof, the edit` from scripts/prove-privy.ts. Kept in step with the same rule in
 * packages/web/components/explore/sort.ts, which is what a judge sees on Explore.
 */
const TEST_TITLE = /^moolam (seed|prove-it|privy proof)\b/i;

const IPFS_SCHEME = "ipfs://";
const JSON_DATA_URI = "data:application/json,";
const TIMEOUT_MS = 10_000;
const PASSPORT_ID = /^0x[0-9a-f]{64}$/;

/**
 * What the verify service's GET /unseal/{passportId} said. "failed" is kept apart from "none" on
 * purpose: a service that could not answer says nothing about the passport, so it must never be read
 * as "still sealed" (refused for good) nor as "published" (a report spent on a guess).
 */
export type RecordLookup =
  | { kind: "found" }
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

/** A picture worth sweeping: readable, not a seed card, and not sealed. */
export function isRealPicture(document: Document): boolean {
  return document.readable && !document.sealed && !isTestCard(document.title);
}

/**
 * One passport's pinned document.
 *
 * A passport either names a JSON file on IPFS or carries the document inline as a data URI, and
 * both are read, because this has to work with whatever the creator's app wrote on chain. A
 * gateway that says nothing leaves `readable` false, which keeps the passport out of the sweep
 * this pass instead of spending a report on a record nobody can check.
 */
export async function readDocument(
  metadataURI: string,
  gateway: string,
  fetcher: Fetcher = fetch,
): Promise<Document> {
  const unreadable: Document = { title: null, sealed: false, unsealed: false, readable: false };

  let text: string;
  if (metadataURI.startsWith(JSON_DATA_URI)) {
    try {
      text = decodeURIComponent(metadataURI.slice(JSON_DATA_URI.length));
    } catch {
      return unreadable;
    }
  } else {
    const url = fetchUrl(gateway, metadataURI);
    if (url === null) {
      return unreadable;
    }
    try {
      const response = await fetcher(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!response.ok) {
        return unreadable;
      }
      text = await response.text();
    } catch {
      return unreadable;
    }
  }

  try {
    return describe(JSON.parse(text) as unknown);
  } catch {
    return unreadable;
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
    return { title: null, sealed: false, unsealed: false, readable: false };
  }
  const record = parsed as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name : null;
  const picture = uriOf(record.thumbnail) ?? uriOf(record.image);

  return {
    title: name,
    sealed: record.sealed === true && picture === null,
    unsealed: false,
    readable: true,
  };
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
  return { ...document, sealed: false, unsealed: true };
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
  const named = typeof body === "object" && body !== null ? (body as { passportId?: unknown }).passportId : undefined;
  if (typeof named !== "string") {
    return { kind: "failed", reason: "the unseal record lookup answered status 200 with no passport id" };
  }
  return passportKey(named) === id ? { kind: "found" } : { kind: "mismatch" };
}

function uriOf(value: unknown): string | null {
  return typeof value === "string" && /^(ipfs:\/\/|https?:\/\/)/.test(value) ? value : null;
}

export function fetchUrl(gateway: string, reference: string): string | null {
  if (reference.startsWith("https://") || reference.startsWith("http://")) {
    return reference;
  }
  if (reference.startsWith(IPFS_SCHEME)) {
    return `${gateway}${reference.slice(IPFS_SCHEME.length)}`;
  }
  return null;
}
