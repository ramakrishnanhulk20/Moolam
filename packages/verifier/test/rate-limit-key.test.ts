// Covers the address the rate limit counts on (review pass 6, answers #2, V44): an IPv4 address
// written inside IPv6 is the IPv4 address, and a real IPv6 address counts as its /64, because every
// IPv6 host holds at least a /64 and could otherwise take a fresh bucket for every request. The
// service-wide limit and a route's own limit both key on it.
// Does NOT cover what the Railway edge writes into X-Forwarded-For, which decides whether IPv6
// callers reach this service at all, or TRUST_PROXY, which is test/headers.test.ts.

import { describe, expect, it } from "vitest";
import { buildServer, rateLimitKey } from "../src/server.js";

describe("the rate limit key", () => {
  it("folds two addresses in one IPv6 /64 into one bucket, and keeps two /64s apart", () => {
    expect(rateLimitKey("2001:db8::1")).toBe(rateLimitKey("2001:db8::2"));
    expect(rateLimitKey("2001:db8:0:0:ffff:ffff:ffff:ffff")).toBe(rateLimitKey("2001:db8::1"));
    expect(rateLimitKey("2001:db8:0:1::1")).not.toBe(rateLimitKey("2001:db8::1"));
  });

  it("unwraps an IPv4-mapped address to its IPv4, so two mapped callers keep their own buckets", () => {
    expect(rateLimitKey("::ffff:1.2.3.4")).not.toBe(rateLimitKey("::ffff:5.6.7.8"));
    expect(rateLimitKey("::ffff:1.2.3.4")).toBe("1.2.3.4");
  });

  it("keys a plain IPv4 address as itself, as it always did", () => {
    expect(rateLimitKey("198.51.100.7")).toBe("198.51.100.7");
  });

  it("puts every address it cannot read into one shared bucket rather than one each", () => {
    expect(rateLimitKey("not an address")).toBe(rateLimitKey("also not one"));
  });

  it("refuses the 61st request in a minute from one IPv6 host that spreads them across its /64", async () => {
    const app = await buildServer({ source: { load: async () => [] }, logger: false });
    await app.ready();
    try {
      const codes: number[] = [];
      for (let i = 1; i <= 61; i += 1) {
        const response = await app.inject({
          method: "POST",
          url: "/verify",
          payload: {},
          remoteAddress: `2001:db8:1:2::${i.toString(16)}`,
        });
        codes.push(response.statusCode);
      }
      expect(codes.slice(0, 60).every((code) => code === 400)).toBe(true);
      expect(codes[60]).toBe(429);
    } finally {
      await app.close();
    }
  });
});
