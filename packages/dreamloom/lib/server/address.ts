import { isIP } from "node:net";

/**
 * The address a request came from, for the per-address weave cap.
 *
 * Railway's proxy appends the address it saw to X-Forwarded-For, so the right-most entry is the
 * only one no caller can write; everything to its left is whatever the caller sent. No header means
 * a direct local request, which counts as "local".
 *
 * Covers: a caller who puts other addresses in front to spread their weaves over many buckets.
 * Does not cover: a caller with many real addresses, and any host that does not append to this
 * header, where the right-most entry would be the caller's own. Anything that is not an IP address
 * falls into one shared "unknown" bucket, so a malformed header can only make its sender share a cap.
 */
export function callerAddress(request: Request): string {
  const header = request.headers.get("x-forwarded-for");
  if (header === null) return "local";
  const entries = header.split(",");
  const last = entries[entries.length - 1]!.trim().toLowerCase();
  return isIP(last) !== 0 ? last : "unknown";
}
