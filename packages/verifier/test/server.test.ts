// Covers the HTTP surface: health, a good upload, rejected bodies, unknown
// routes and the rate limit. Requests go through fastify.inject, so no port is
// bound.
// Does NOT cover the remote URL fetch path against a real network, and does not
// cover TLS or any deployment concern.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { fingerprint } from "../src/fingerprint.js";
import { buildServer } from "../src/server.js";
import type { PassportSource } from "../src/source/PassportSource.js";
import type { PassportRecord } from "../src/types.js";
import { makeImage, recordFor } from "./helpers.js";

function sourceOf(records: PassportRecord[]): PassportSource {
  return { load: async () => records };
}

function multipartBody(field: string, filename: string, contentType: string, content: Buffer): {
  payload: Buffer;
  headers: Record<string, string>;
} {
  const boundary = "----moolamtest";
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, content, tail]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
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

  it("refuses to fetch loopback, private and localhost URLs", async () => {
    for (const url of ["http://127.0.0.1/x.jpg", "http://10.0.0.8/x.jpg", "http://localhost:4010/x.jpg", "http://[::1]/x.jpg"]) {
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
