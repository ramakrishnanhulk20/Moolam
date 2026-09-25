/**
 * What the sealed workflow accepts, decided without any network so it can be tested outside the
 * sandbox. Its only import is the public workflow's pinned.ts, which imports nothing, so
 * packages/recheck-runner/test/sealed-private-copy.test.ts can still load this file under Node,
 * where the CRE SDK does not load.
 *
 * Every refusal here names a status, a size or the passport id, and never a URL or a token. The
 * CLI prints a thrown error, the runner copies it into a reason, and the verify service serves that
 * reason on a public route, so a link or a token in one of these strings would be published.
 */

import { MAX_DOCUMENT_BYTES, pinnedFetchUrl } from "../moolam-verifier/pinned";

export { MAX_DOCUMENT_BYTES };

const HTTPS_SCHEME = "https://";

/**
 * The private thumbnail is made by the verify service at 512 px and refused there above this size,
 * so anything larger is not the file the service kept, and it is not handed to the decoder.
 */
export const MAX_PRIVATE_FILE_BYTES = 60_000;

/** Longer than any signed link Pinata writes, and short enough that a pasted page is refused. */
const MAX_LINK_LENGTH = 2_048;

/**
 * A host name in lower case with at least one dot: letters, digits and hyphens between the dots.
 * No port, no user, no brackets, no percent sign, no trailing dot. The configured private gateway
 * host is held to this, and a served link must carry exactly that host.
 */
export const GATEWAY_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** Printable ASCII without the space: no control character, no whitespace and no Unicode. */
const PRINTABLE = /^[\x21-\x7e]+$/;

/**
 * The one rule for comparing passport ids, so a difference in letter case can neither pass a
 * mismatch nor fail a match. The same function as picture.ts and the runner's document.ts.
 */
export const passportKey = (value: string): string => value.toLowerCase();

/**
 * Whether a metadata document asks for a private re-check and leaves nothing public to re-check.
 *
 * A byte for byte copy of the verify service's predicate in packages/verifier/src/sealed.ts, held
 * to that file by a test that compares the two function texts, and run against the same fixture
 * set, packages/verifier/test/fixtures/sealed-documents.json.
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
 * Where the passport's metadata document is read from, or null when it is not read at all.
 *
 * The one rule both workflows and the runner share, pinnedFetchUrl in
 * packages/workflow/moolam-verifier/pinned.ts: only `ipfs://` followed by a content id and nothing
 * else, always built on the configured gateway. An http(s) address, a data URI, a path or a query
 * after the content id, or anything else a creator could write on chain is refused, so the enclave
 * never fetches an address somebody else chose.
 */
export const metadataFetchUrl = (gateway: string, metadataURI: string): string | null =>
  pinnedFetchUrl(gateway, metadataURI);

/**
 * The link, when it is https on exactly the configured private gateway host, or null.
 *
 * The sandbox has no working URL global, so this reads the link by hand, and it only accepts the
 * form no two parsers can read differently: lower case `https://`, then the host, then a `/`. The
 * text between the scheme and the first `/`, `?` or `#` must equal the host as a whole string, so
 * a port, a user and password, an `@`, a backslash, a trailing dot, upper case letters or a
 * percent sign all fail it. Whitespace, control characters and anything outside ASCII are refused
 * anywhere in the link. A fragment is refused too: a signed link has none.
 *
 * It does not check the path or the query: which file the link opens is the verify service's
 * choice, and the service is the party that names it.
 */
export const acceptedLink = (link: unknown, host: string): string | null => {
  if (!GATEWAY_HOST.test(host)) return null;
  if (typeof link !== "string" || link.length > MAX_LINK_LENGTH) return null;
  if (!PRINTABLE.test(link) || link.includes("\\") || link.includes("#")) return null;
  if (!link.startsWith(HTTPS_SCHEME)) return null;

  const rest = link.slice(HTTPS_SCHEME.length);
  const end = rest.search(/[/?#]/);
  if (end === -1 || rest[end] !== "/") return null;
  if (rest.slice(0, end) !== host) return null;
  return link;
};

export type LinkAnswer = { kind: "link"; url: string } | { kind: "refused"; reason: string };

/**
 * What POST /sealed/link answered, as the enclave received it: a link it will open, or a refusal.
 * The service answers `{ url, expiresAt }`, and only `url` is read.
 */
export const readLinkAnswer = (
  status: number,
  body: string,
  host: string,
  passportId: string,
): LinkAnswer => {
  if (status !== 200) {
    return { kind: "refused", reason: refusal.linkStatus(passportId, status) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { kind: "refused", reason: refusal.linkUnreadable(passportId) };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "refused", reason: refusal.linkUnreadable(passportId) };
  }
  const url = (parsed as Record<string, unknown>).url;
  if (typeof url !== "string") {
    return { kind: "refused", reason: refusal.linkUnreadable(passportId) };
  }
  const accepted = acceptedLink(url, host);
  if (accepted === null) {
    return { kind: "refused", reason: refusal.linkOffGateway(passportId) };
  }
  return { kind: "link", url: accepted };
};

/**
 * Why the private file's answer is not decoded, or null when it may be. Checked on the status and
 * the byte count before a single byte reaches the JPEG decoder.
 */
export const privateFileRefusal = (status: number, length: number, passportId: string): string | null => {
  if (status !== 200) return refusal.fileStatus(passportId, status);
  if (length === 0) return refusal.fileEmpty(passportId);
  if (length > MAX_PRIVATE_FILE_BYTES) return refusal.fileTooLarge(passportId, length);
  return null;
};

/**
 * How many times a GET that does not answer is tried. Pinata's private gateway answered the first
 * fetch through a fresh link in 6 to 12 seconds on 2026-09-25, past the capability's 10 second
 * ceiling, and every repeat on the same link in about one second. Three tries of one link stay well
 * inside its 120 second life and the run's 15 call budget.
 */
export const FETCH_TRIES = 3;

/**
 * The first answer from up to `tries` calls. Only a call that throws, which is how the capability
 * reports a timeout or a dropped connection, is tried again; any status the server answers with is
 * returned as it came, so a refusal is never retried into a different answer.
 */
export const firstAnswer = <T>(tries: number, call: () => T): T => {
  let miss: unknown = new Error("no attempt was made");
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      return call();
    } catch (thrown) {
      miss = thrown;
    }
  }
  throw miss;
};

/** The verdict line, in the shape the public workflow prints and the runner's parser reads. */
export const verdictLine = (recomputed: string, distance: number, matched: boolean): string =>
  `recomputed ${recomputed} distance ${distance} matched ${matched}`;

/** The report line, in the shape the public workflow prints and the runner's parser reads. */
export const reportLine = (txHash: string): string => `report tx ${txHash}`;

/**
 * Every reason a sealed run ends without a report. One place, so a test can hold all of them to
 * the rule that none carries an address or a credential.
 */
export const refusal = {
  metadataNotIpfs: (passportId: string): string =>
    `passport ${passportId} names metadata that is not an IPFS content id, so the sealed workflow does not read it`,
  metadataStatus: (passportId: string, status: number): string =>
    `metadata for passport ${passportId} answered status ${status}`,
  metadataTooLarge: (passportId: string, length: number): string =>
    `metadata for passport ${passportId} is ${length} bytes, over the ${MAX_DOCUMENT_BYTES} byte cap`,
  metadataUnreadable: (passportId: string): string =>
    `metadata for passport ${passportId} is not a JSON document`,
  notRecheckable: (passportId: string): string =>
    `passport ${passportId} is not privately re-checkable: its document does not ask for a private re-check or names a public picture, so there is no private copy to open`,
  noAnswer: (what: string, passportId: string): string => `${what} for passport ${passportId} did not answer`,
  tokenMissing: (passportId: string): string =>
    `the sealed link token was not released to the run for passport ${passportId}`,
  linkStatus: (passportId: string, status: number): string =>
    `the private link request for passport ${passportId} answered status ${status}`,
  linkUnreadable: (passportId: string): string =>
    `the private link request for passport ${passportId} answered status 200 without a link this workflow reads`,
  linkOffGateway: (passportId: string): string =>
    `the link served for passport ${passportId} is not https on the private gateway, so it is not opened`,
  fileStatus: (passportId: string, status: number): string =>
    `the private copy fetch for passport ${passportId} returned status ${status}`,
  fileEmpty: (passportId: string): string => `the private copy fetch for passport ${passportId} returned no bytes`,
  fileTooLarge: (passportId: string, length: number): string =>
    `the private copy for passport ${passportId} is ${length} bytes, over the ${MAX_PRIVATE_FILE_BYTES} byte cap, so it is not decoded`,
  fileNotJpeg: (passportId: string): string =>
    `the private copy for passport ${passportId} is not a JPEG this workflow decodes`,
};
