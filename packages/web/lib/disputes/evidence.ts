import { keccak256, toBytes, type Hex } from "viem";
import { gatewayUrl } from "@/lib/chain/client";

/**
 * The reason behind a flag, and how it reaches the chain.
 *
 * The registry stores the keccak256 of the evidence URI and nothing else, so
 * the URI has to hold the reason itself for anyone to read it later. Pinning a
 * small JSON would mean a new upload route and a pin that can disappear, so the
 * reason travels as a data: URI instead: it is carried by the transaction, kept
 * in the event log, and hashed by the contract the same way any other URI is.
 *
 * The cost is length. Every character is calldata, which is why the reason is
 * capped well under what a pinned document could hold.
 */

/** The shortest reason worth putting a bond behind. */
export const REASON_MIN = 20;
/** The longest one, in characters, before the calldata gets expensive. */
export const REASON_MAX = 500;

const PREFIX = "data:text/plain;charset=utf-8,";

/** Why a reason cannot be sent, as a key under "passport.dispute.failure". */
export type ReasonProblem = "reasonShort" | "reasonLong";

/** What is wrong with the typed reason, or null when it can be sent. */
export function checkReason(reason: string): ReasonProblem | null {
  const trimmed = reason.trim();
  if (trimmed.length < REASON_MIN) {
    return "reasonShort";
  }
  return trimmed.length > REASON_MAX ? "reasonLong" : null;
}

/** The reason as the URI the transaction carries. */
export function evidenceUri(reason: string): string {
  return `${PREFIX}${encodeURIComponent(reason.trim())}`;
}

/**
 * The reason back out of a stored URI, or null when the URI points somewhere
 * else. An older or hand made dispute may carry an ipfs:// or https:// URI,
 * and that is a link to follow rather than text to print.
 */
export function reasonFrom(uri: string): string | null {
  if (!uri.startsWith(PREFIX)) {
    return null;
  }
  try {
    const text = decodeURIComponent(uri.slice(PREFIX.length)).trim();
    return text.length === 0 ? null : text;
  } catch {
    return null;
  }
}

// The shape MoolamDecisions holds a reasons address to: ipfs:// and a content
// id of letters and digits, 46 to 121 of them, with no path, query or host.
const PINNED_ADDRESS = /^ipfs:\/\/[A-Za-z0-9]{46,121}$/;

/**
 * Where a browser may follow an address a stranger wrote, or null (L28, L29).
 *
 * Only ipfs://<cid> becomes a link, through this deploy's gateway, because a
 * content id can only ever name the bytes it was made from. Anything else, an
 * https page included, is drawn as text by the caller and never linked.
 */
export function pinnedLink(uri: string): string | null {
  return PINNED_ADDRESS.test(uri) ? gatewayUrl(uri) : null;
}

/** What the registry stores for a URI: the keccak256 of its bytes. */
export function evidenceHash(uri: string): Hex {
  return keccak256(toBytes(uri));
}

/**
 * Whether a URI the index handed back is the one the chain was flagged with.
 *
 * The index is a mirror, and a mirror can be wrong or behind. The hash on the
 * record is the original, so the reason is only printed when the two agree.
 */
export function evidenceMatches(uri: string, hash: Hex): boolean {
  return evidenceHash(uri).toLowerCase() === hash.toLowerCase();
}
