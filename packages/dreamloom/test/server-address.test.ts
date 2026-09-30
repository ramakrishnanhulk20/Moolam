// What this file does not cover: whether Railway's proxy really appends to X-Forwarded-For. That
// is a fact about the host, checked against the live request log at deploy time.
import { describe, expect, it } from "vitest";
import { callerAddress } from "@/lib/server/address";

function from(forwarded?: string): Request {
  const headers = new Headers();
  if (forwarded !== undefined) headers.set("x-forwarded-for", forwarded);
  return new Request("http://localhost:3300/api/weave", { headers });
}

describe("callerAddress", () => {
  it("takes the right-most entry the proxy appended", () => {
    expect(callerAddress(from("203.0.113.9"))).toBe("203.0.113.9");
  });

  it("ignores a spoofed entry on the left", () => {
    expect(callerAddress(from("1.1.1.1, 2.2.2.2, 203.0.113.9"))).toBe("203.0.113.9");
    expect(callerAddress(from("9.9.9.9, 203.0.113.9"))).toBe(callerAddress(from("8.8.8.8, 203.0.113.9")));
  });

  it("answers local with no header", () => {
    expect(callerAddress(from())).toBe("local");
  });

  it("puts anything that is not an address into one shared bucket", () => {
    expect(callerAddress(from("203.0.113.9, not-an-ip"))).toBe("unknown");
    expect(callerAddress(from("203.0.113.9, "))).toBe("unknown");
  });
});
