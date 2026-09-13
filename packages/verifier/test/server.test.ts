// Covers the HTTP surface: health, a good upload, rejected bodies, the refused
// fetch targets, unknown routes, the body limits and the rate limit.
// Requests go through fastify.inject, so no port is bound.
// Does NOT cover the remote URL fetch path against a real network, does not cover
// the boot refusals or the match gate giving up, which are in boot.test.ts, and
// does not cover TLS or any deployment concern.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { fingerprint } from "../src/fingerprint.js";
import { buildServer } from "../src/server.js";
import type { PassportSource } from "../src/source/PassportSource.js";
import type { PassportRecord } from "../src/types.js";
import { makeImage, makeOversizeImage, multipartBody, recordFor } from "./helpers.js";

function sourceOf(records: PassportRecord[]): PassportSource {
  return { load: async () => records };
}

describe("verify service", () => {
  let app: FastifyInstance;
  let registered: Buffer;

  beforeAll(async () => {
    registered = await makeImage(61);
    const record = recordFor(await fingerprint(registered));
    app = await buildServer({ source: sourceOf([record]), logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("reports health with the record count and the version", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, records: 1 });
    expect(typeof response.json().version).toBe("string");
  });

  it("returns an exact match for a registered image, with the pHash as a decimal string", async () => {
    const { payload, headers } = multipartBody("file", "a.jpg", "image/jpeg", registered);
    const response = await app.inject({ method: "POST", url: "/verify", payload, headers });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.result.exact).toMatch(/^0x[0-9a-f]{64}$/);
    expect(body.result.confidence).toBe(1);
    expect(typeof body.result.queried.phash).toBe("string");
    expect(body.manifest.present).toBe(false);
  });

  it("refuses to fetch loopback, private and localhost URLs, in every spelling", async () => {
    for (const url of [
      "http://127.0.0.1/x.jpg",
      "http://10.0.0.8/x.jpg",
      "http://localhost:4010/x.jpg",
      "http://[::1]/x.jpg",
      "http://[::ffff:127.0.0.1]/x.jpg",
      "http://[::ffff:a9fe:a9fe]/x.jpg",
      "http://0x7f000001/x.jpg",
      "http://2130706433/x.jpg",
    ]) {
      const response = await app.inject({ method: "POST", url: "/verify", payload: { url } });
      expect(response.statusCode, url).toBe(403);
      expect(response.json().error).toContain("not a public address");
    }
  });

  it("returns 400 for a JSON body that is neither a file nor a url", async () => {
    const response = await app.inject({ method: "POST", url: "/verify", payload: { nope: 1 } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/url/);
  });

  it("returns 400 for a text file dressed up as an upload", async () => {
    const { payload, headers } = multipartBody("file", "notes.txt", "text/plain", Buffer.from("not an image"));
    const response = await app.inject({ method: "POST", url: "/verify", payload, headers });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/not an image/);
  });

  it("refuses an image over the pixel limit with 413 and says why", async () => {
    const { payload, headers } = multipartBody("file", "bomb.jpg", "image/jpeg", await makeOversizeImage());
    const response = await app.inject({ method: "POST", url: "/verify", payload, headers });

    expect(response.statusCode).toBe(413);
    expect(response.json().error).toMatch(/pixel limit/);
  }, 30_000);

  it("returns 400 when the multipart field is not called file", async () => {
    const { payload, headers } = multipartBody("photo", "a.jpg", "image/jpeg", registered);
    const response = await app.inject({ method: "POST", url: "/verify", payload, headers });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/"file"/);
  });

  it("answers unknown routes with JSON, not HTML", async () => {
    const response = await app.inject({ method: "GET", url: "/nope" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toMatch(/no route/);
  });
});

describe("body limits", () => {
  it("refuses a 20 KB JSON body with 413 and still takes a 5 MB upload", async () => {
    const app = await buildServer({ source: sourceOf([]), logger: false });
    await app.ready();

    try {
      const fat = JSON.stringify({ url: `https://example.com/${"a".repeat(20 * 1024)}.jpg` });
      const json = await app.inject({
        method: "POST",
        url: "/verify",
        payload: fat,
        headers: { "content-type": "application/json" },
      });
      expect(json.statusCode).toBe(413);

      const { payload, headers } = multipartBody("file", "big.jpg", "image/jpeg", Buffer.alloc(5 * 1024 * 1024, 7));
      const upload = await app.inject({ method: "POST", url: "/verify", payload, headers });
      expect(upload.statusCode).not.toBe(413);
      expect(upload.statusCode).toBe(400);
      expect(upload.json().error).toMatch(/not an image/);
    } finally {
      await app.close();
    }
  }, 30_000);
});

describe("rate limit", () => {
  it("allows 60 requests a minute from one address and rejects the 61st", async () => {
    const app = await buildServer({ source: sourceOf([]), logger: false });
    await app.ready();

    try {
      for (let i = 0; i < 60; i += 1) {
        const response = await app.inject({ method: "GET", url: "/health", remoteAddress: "203.0.113.7" });
        expect(response.statusCode).toBe(200);
      }

      const blocked = await app.inject({ method: "GET", url: "/health", remoteAddress: "203.0.113.7" });
      expect(blocked.statusCode).toBe(429);

      const other = await app.inject({ method: "GET", url: "/health", remoteAddress: "203.0.113.8" });
      expect(other.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  }, 30_000);
});
