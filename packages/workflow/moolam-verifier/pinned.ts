/**
 * What a Moolam workflow may fetch because a registrant wrote it on chain: pinned content only,
 * through the configured gateway, under a fixed byte cap. Both workflows import this file. No
 * imports on purpose: the runner's tests load it directly under Node, where the CRE SDK does not
 * load, and the runner keeps a byte for byte copy of pinnedContentId in its own document.ts,
 * held to this text by packages/recheck-runner/test/workflow-picture.test.ts.
 */

/**
 * A Moolam metadata document is under 2 KB: the prove-it passport's is 875 bytes. The cap only
 * stops a document registered outside Moolam from making a node read or parse something large.
 */
export const MAX_DOCUMENT_BYTES = 32_000;

/**
 * The verify service makes every thumbnail at most 512 px on its longest side and refuses one over
 * 60,000 bytes (packages/verifier/src/prepare.ts, THUMBNAIL_MAX_BYTES). Real ones are 23,800 bytes
 * (the prove-it passport) and 24,583 and 40,681 bytes (proofs/rechecks.txt), so anything larger is
 * not a picture Moolam made, and the HTTP capability's own ceiling is 100 KB in any case.
 */
export const MAX_PICTURE_BYTES = 60_000;

/**
 * The content id in `ipfs://<cid>`, or null for anything else.
 *
 * Letters and digits only after the scheme, so an address cannot carry a path, a query, a port, a
 * user, a second host or another scheme onto the gateway. An http(s) address, a data URI, a bare
 * id with no scheme, an upper case scheme and an empty id are all null. It does not check that the
 * id is a well formed multihash: a gateway that cannot resolve it answers with an error status,
 * and the fetch stops on that like any other refusal.
 */
export function pinnedContentId(reference: unknown): string | null {
  if (typeof reference !== "string" || !reference.startsWith("ipfs://")) {
    return null;
  }
  const cid = reference.slice("ipfs://".length);
  return /^[A-Za-z0-9]+$/.test(cid) ? cid : null;
}

/** The gateway URL for a pinned reference, or null when the reference is not `ipfs://<cid>`. */
export const pinnedFetchUrl = (gateway: string, reference: unknown): string | null => {
  const cid = pinnedContentId(reference);
  if (cid === null) return null;
  return `${gateway.endsWith("/") ? gateway : `${gateway}/`}${cid}`;
};

/**
 * Why a gateway answer is not used, or null when it may be. Only a 200 is read: the HTTP capability
 * fails on a redirect by itself, and a 3xx that did come back is refused here like any other
 * status, so no redirect is ever followed. The size is checked before a byte is parsed or decoded.
 * The reason names the status or the size and never the address.
 */
export const pinnedBodyRefusal = (what: string, status: number, length: number, cap: number): string | null => {
  if (status !== 200) return `${what} answered status ${status}`;
  if (length > cap) return `${what} is ${length} bytes, over the ${cap} byte cap`;
  return null;
};
