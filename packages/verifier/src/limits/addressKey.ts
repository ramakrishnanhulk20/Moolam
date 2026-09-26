import ipaddr from "ipaddr.js";

/** Every address the key below cannot read shares this one bucket, so a malformed value buys nothing. */
const UNREADABLE_ADDRESS = "unreadable-address";

/**
 * The bucket a caller's requests are counted in (review pass 6, V44).
 *
 * ipaddr.process unwraps an IPv4 address written inside IPv6 (::ffff:a.b.c.d) to that IPv4, so a
 * dual-stack listener counts it exactly as the plain address. A true IPv6 address is folded to its
 * /64, because every IPv6 host is handed at least a /64 and could otherwise take a fresh bucket for
 * every request; that is the fold @fastify/rate-limit's own default makes, which the custom key
 * used to replace. Covers every address ipaddr.js parses, zone ids included. Does not fold a
 * larger allocation than a /64, so a host holding a /48 still has 65,536 buckets.
 */
export function rateLimitKey(ip: string): string {
  let parsed: ReturnType<typeof ipaddr.process>;
  try {
    parsed = ipaddr.process(ip);
  } catch {
    return UNREADABLE_ADDRESS;
  }
  if (parsed.kind() === "ipv4") {
    return parsed.toString();
  }
  const words = (parsed as ipaddr.IPv6).parts.slice(0, 4).map((word) => word.toString(16));
  return `${words.join(":")}::/64`;
}
