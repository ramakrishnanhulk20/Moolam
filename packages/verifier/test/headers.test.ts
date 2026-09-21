// Covers the security headers the service puts on every answer: a 200, a 4xx, the /health probe
// and a CORS preflight all carry the same four, no answer advertises the framework, and the
// cross-origin rules the studio depends on still work with those headers in place, which is the
// one way this change could have broken the product.
// Does NOT cover a real browser enforcing any of it, does not cover the HSTS header having any
// effect over plain HTTP (the host redirects to https before this service is reached), and does
// not cover a Content-Security-Policy, which belongs to the app rather than to a JSON API.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import type { PassportSource } from "../src/source/PassportSource.js";
import { makeImage, multipartBody } from "./helpers.js";

// env.ts reads CORS_ORIGINS once at import, so the list has to be in place before the imports
// above are evaluated. vi.hoisted runs first.
const APP_ORIGIN = vi.hoisted(() => {
  const origin = "https://moolam.example";
  process.env.CORS_ORIGINS = origin;
  return origin;
});

const emptySource: PassportSource = { load: async () => [] };

const EXPECTED: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "cross-origin-resource-policy": "cross-origin",
};

function expectHardened(headers: Record<string, unknown>, what: string): void {
  for (const [name, value] of Object.entries(EXPECTED)) {
    expect(headers[name], `${what} is missing ${name}`).toBe(value);
  }
  // Fastify sends no framework header of its own. This is the test that would notice if a plugin
  // or a later Fastify ever started to.
  expect(headers["x-powered-by"], what).toBeUndefined();
  expect(String(headers["server"] ?? "").toLowerCase(), what).not.toContain("fastify");
}

describe("security headers", () => {
  let app: FastifyInstance;
  let picture: Buffer;

  beforeAll(async () => {
    picture = await makeImage(23);
    app = await buildServer({ source: emptySource, logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("puts them on an answer that worked", async () => {
    const { payload, headers } = multipartBody("file", "a.jpg", "image/jpeg", picture);
    const response = await app.inject({ method: "POST", url: "/verify", payload, headers });

    expect(response.statusCode).toBe(200);
    expectHardened(response.headers as Record<string, unknown>, "a 200");
  });

  it("puts them on a refusal and on an unknown route", async () => {
    const bad = await app.inject({ method: "POST", url: "/verify", payload: { nope: 1 } });
    expect(bad.statusCode).toBe(400);
    expectHardened(bad.headers as Record<string, unknown>, "a 400");

    const missing = await app.inject({ method: "GET", url: "/nowhere" });
    expect(missing.statusCode).toBe(404);
    expectHardened(missing.headers as Record<string, unknown>, "a 404");
  });

  it("puts them on the health probe, which no limiter and no hook may skip", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expectHardened(response.headers as Record<string, unknown>, "/health");
  });

  it("leaves the studio's cross-origin upload working: preflight and a real POST both pass", async () => {
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/verify",
      headers: {
        origin: APP_ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    expect(preflight.headers["access-control-allow-origin"]).toBe(APP_ORIGIN);
    expectHardened(preflight.headers as Record<string, unknown>, "a preflight");

    const { payload, headers } = multipartBody("file", "a.jpg", "image/jpeg", picture);
    const posted = await app.inject({
      method: "POST",
      url: "/verify",
      payload,
      headers: { ...headers, origin: APP_ORIGIN },
    });
    expect(posted.statusCode).toBe(200);
    expect(posted.headers["access-control-allow-origin"]).toBe(APP_ORIGIN);
    expectHardened(posted.headers as Record<string, unknown>, "a POST from the app");
  });

  it("still gives a stranger's origin no allow header", async () => {
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/verify",
      headers: { origin: "https://evil.example.com", "access-control-request-method": "POST" },
    });

    expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();
    // The hardening is not a CORS decision: a stranger gets these and still gets no allow header.
    expectHardened(preflight.headers as Record<string, unknown>, "a stranger's preflight");
  });
});
