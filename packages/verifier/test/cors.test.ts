// Covers the browser rules: an origin named in CORS_ORIGINS gets the allow header on a preflight
// and on the answer itself, and an origin that is not named gets none, which the browser turns
// into a refusal.
// Does NOT cover a real browser enforcing any of this, and does not cover credentialed requests:
// the studio sends its Privy token in an Authorization header, never in a cookie.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import type { PassportSource } from "../src/source/PassportSource.js";

// env.ts reads CORS_ORIGINS once at import, so the list has to be in place before the imports
// above are evaluated. vi.hoisted runs first.
const ALLOWED = vi.hoisted(() => {
  const origin = "http://localhost:3210";
  process.env.CORS_ORIGINS = `${origin},https://moolam.example`;
  return origin;
});

const emptySource: PassportSource = { load: async () => [] };
let app: FastifyInstance;

describe("cross-origin rules", () => {
  beforeAll(async () => {
    app = await buildServer({ source: emptySource, logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("answers a preflight from an allowed origin with that origin and the headers the studio sends", async () => {
    const response = await app.inject({
      method: "OPTIONS",
      url: "/prepare",
      headers: {
        origin: ALLOWED,
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
    });

    expect(response.headers["access-control-allow-origin"]).toBe(ALLOWED);
    expect(String(response.headers["access-control-allow-methods"])).toContain("POST");
    expect(String(response.headers["access-control-allow-headers"]).toLowerCase()).toContain("authorization");
  });

  it("gives a stranger's origin no allow header on a preflight", async () => {
    const response = await app.inject({
      method: "OPTIONS",
      url: "/prepare",
      headers: {
        origin: "https://not-moolam.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
    });

    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("allows the same origins on /verify and /health", async () => {
    const health = await app.inject({ method: "GET", url: "/health", headers: { origin: ALLOWED } });
    expect(health.statusCode).toBe(200);
    expect(health.headers["access-control-allow-origin"]).toBe(ALLOWED);

    const verify = await app.inject({
      method: "OPTIONS",
      url: "/verify",
      headers: { origin: "https://moolam.example", "access-control-request-method": "POST" },
    });
    expect(verify.headers["access-control-allow-origin"]).toBe("https://moolam.example");
  });
});
