// Covers the HTTP surface: health, a good upload, rejected bodies, the refused
// fetch targets, unknown routes, the body limits and the rate limit, and /health answering fast
// while a 40 megapixel upload is being matched (review pass 5, answers 1), and every route's
// error answer in the service's own shape, a thrown message never included (pass 7, V61). From
// pass 11: every URL the service would not or could not fetch answers one status and one sentence
// (V118), and a GIF registered straight on chain is answered exact by its own file (V115).
// Requests go through fastify.inject, so no port is bound.
// Does NOT cover the remote URL fetch path against a real network, does not cover
// the boot refusals or the match gate giving up, which are in boot.test.ts, and
// does not cover TLS or any deployment concern.

import { createHash } from "node:crypto";
import { promises as dnsPromises } from "node:dns";
import { createServer } from "node:http";
import net from "node:net";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { MAX_IMAGE_PIXELS, fingerprint } from "../src/fingerprint.js";
import { buildServer } from "../src/server.js";
import type { PassportSource } from "../src/source/PassportSource.js";
import type { Hex, PassportRecord } from "../src/types.js";
import { makeImage, makeOversizeImage, multipartBody, recordFor } from "./helpers.js";

/** The one thing the URL form says about an address it could not fetch, whatever the reason (V118). */
const URL_REFUSED = "that address could not be fetched";

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
      expect(response.statusCode, url).toBe(502);
      expect(response.json(), url).toEqual({ error: URL_REFUSED });
    }
  });

  // Review pass 11, answers #6 (V118): a 403 for a name that resolves inside our network, a 502
  // "could not resolve" for one that does not, and the connect error for a public port made the
  // service an oracle for its own resolver's names and a port prober from Moolam's address.
  it("answers a private name, an unresolvable name and a refused port with the same status and sentence", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const closedPort = (closed.address() as { port: number }).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    const noSuchName = (): Promise<string[]> =>
      Promise.reject(Object.assign(new Error("queryA ENOTFOUND"), { code: "ENOTFOUND" }));
    const answers = (host: string): Promise<string[]> =>
      host === "internal.example.test" ? Promise.resolve(["10.0.0.9"]) : noSuchName();
    const resolve4 = vi.spyOn(dnsPromises.Resolver.prototype, "resolve4").mockImplementation(answers);
    const resolve6 = vi.spyOn(dnsPromises.Resolver.prototype, "resolve6").mockImplementation(noSuchName);
    // The public address literal needs no lookup; only its dial is sent to a closed port on this machine.
    const realConnect = net.connect;
    const connect = vi
      .spyOn(net, "connect")
      .mockImplementation(((options: net.NetConnectOpts) =>
        realConnect({ ...options, host: "127.0.0.1", port: closedPort } as net.NetConnectOpts)) as typeof net.connect);

    try {
      const said = [];
      for (const url of [
        "http://internal.example.test/x.jpg",
        "http://nothing-here.example.test/x.jpg",
        "http://93.184.216.34:8081/x.jpg",
      ]) {
        const response = await app.inject({ method: "POST", url: "/verify", payload: { url } });
        said.push({ status: response.statusCode, body: response.json() });
      }

      expect(said).toEqual([
        { status: 502, body: { error: URL_REFUSED } },
        { status: 502, body: { error: URL_REFUSED } },
        { status: 502, body: { error: URL_REFUSED } },
      ]);
      expect(resolve4).toHaveBeenCalled();
      expect(connect).toHaveBeenCalled();
    } finally {
      resolve4.mockRestore();
      resolve6.mockRestore();
      connect.mockRestore();
    }
  });

  // Review pass 11, answers #3 (V115): the exact lookup waited behind the format and pixel checks,
  // so a passport registered straight on chain from a GIF could never be matched by its own file.
  it("answers a GIF registered straight on chain as exact, with no distances and a plain note", async () => {
    const gif = await sharp(await makeImage(66)).gif().toBuffer();
    const stand = recordFor(await fingerprint(await makeImage(67)));
    const onChain = { ...stand, id: `0x${createHash("sha256").update(gif).digest("hex")}` as Hex };
    const direct = await buildServer({ source: sourceOf([onChain]), logger: false });
    await direct.ready();

    try {
      const { payload, headers } = multipartBody("file", "a.gif", "image/gif", gif);
      const response = await direct.inject({ method: "POST", url: "/verify", payload, headers });

      expect(response.statusCode).toBe(200);
      const result = response.json().result;
      expect(result.exact).toBe(onChain.id);
      expect(result.confidence).toBe(1);
      expect(result.best).toMatchObject({ id: onChain.id });
      expect(result.best).not.toHaveProperty("phashDistance");
      expect(result.best).not.toHaveProperty("blockhashDistance");
      expect(result.queried).toEqual({ sha256: onChain.id });
      expect(result.note).toMatch(/byte for byte/);

      const other = await sharp(await makeImage(68)).gif().toBuffer();
      const stranger = multipartBody("file", "b.gif", "image/gif", other);
      const refused = await direct.inject({ method: "POST", url: "/verify", payload: stranger.payload, headers: stranger.headers });
      expect(refused.statusCode).toBe(400);
    } finally {
      await direct.close();
    }
  }, 30_000);

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

describe("answers 1: a large upload does not freeze the service", () => {
  it("answers /health in under 100 ms while a 40 megapixel upload is matched", async () => {
    const app = await buildServer({ source: sourceOf([]), logger: false });
    await app.ready();

    try {
      // The review's input: one colour, so the file is small and the decode is all that costs.
      const side = 6300;
      const flat = await sharp({ create: { width: side, height: side, channels: 3, background: "#3a6ea5" } })
        .png({ compressionLevel: 9 })
        .toBuffer();
      expect(side * side).toBeLessThanOrEqual(MAX_IMAGE_PIXELS);

      const { payload, headers } = multipartBody("file", "flat.png", "image/png", flat);
      let finished = false;
      const verify = app.inject({ method: "POST", url: "/verify", payload, headers }).finally(() => {
        finished = true;
      });

      // Each wait runs from the moment a probe was due, so a stall that lands between two probes
      // delays the next one and is counted too.
      const waits: number[] = [];
      while (!finished) {
        const due = performance.now() + 20;
        await new Promise((resolve) => setTimeout(resolve, 20));
        const probe = await app.inject({ method: "GET", url: "/health", remoteAddress: "203.0.113.9" });
        waits.push(performance.now() - due);
        expect(probe.statusCode).toBe(200);
      }

      expect((await verify).statusCode).toBe(200);
      expect(waits.length).toBeGreaterThan(5);
      expect(Math.max(...waits)).toBeLessThan(100);
    } finally {
      await app.close();
    }
  }, 60_000);
});

// Pass 7, answers #3 (V61): the handler was set after every route plugin, so every route kept
// Fastify's default, which answers a thrown 5xx with its raw message.
describe("the service's own error answers (pass 7, V61)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer({ source: sourceOf([]), logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("answers a route that throws with the service's own words and no part of the thrown message", async () => {
    const counts = vi.spyOn(app.recheck, "counts").mockImplementationOnce(() => {
      throw new Error("secret https://rpc.example/TOKEN123");
    });

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(counts).toHaveBeenCalled();
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "verifier failed to handle the request" });
    for (const part of ["secret", "rpc.example", "TOKEN123"]) {
      expect(response.body).not.toContain(part);
    }
  });

  it("answers a 413, a 415 and the rate limiter's 429 as { error } alone", async () => {
    const fat = await app.inject({
      method: "POST",
      url: "/verify",
      payload: JSON.stringify({ url: `https://example.com/${"a".repeat(20 * 1024)}.jpg` }),
      headers: { "content-type": "application/json" },
    });
    const odd = await app.inject({
      method: "POST",
      url: "/verify",
      payload: "<picture/>",
      headers: { "content-type": "application/xml" },
    });
    for (let i = 0; i < 60; i += 1) {
      await app.inject({ method: "POST", url: "/verify", remoteAddress: "203.0.113.21" });
    }
    const limited = await app.inject({ method: "POST", url: "/verify", remoteAddress: "203.0.113.21" });

    for (const [response, status] of [
      [fat, 413],
      [odd, 415],
      [limited, 429],
    ] as const) {
      expect(response.statusCode).toBe(status);
      const body = response.json() as Record<string, unknown>;
      expect(Object.keys(body)).toEqual(["error"]);
      expect(typeof body.error).toBe("string");
    }
  }, 30_000);
});

describe("rate limit", () => {
  it("allows 60 requests a minute from one address to a limited route and rejects the 61st", async () => {
    const app = await buildServer({ source: sourceOf([]), logger: false });
    await app.ready();

    // A bodiless POST fails fast with 400 but still counts, so 61 of them exhaust the address.
    try {
      for (let i = 0; i < 60; i += 1) {
        const response = await app.inject({ method: "POST", url: "/verify", remoteAddress: "203.0.113.7" });
        expect(response.statusCode).toBe(400);
      }

      const blocked = await app.inject({ method: "POST", url: "/verify", remoteAddress: "203.0.113.7" });
      expect(blocked.statusCode).toBe(429);

      const other = await app.inject({ method: "POST", url: "/verify", remoteAddress: "203.0.113.8" });
      expect(other.statusCode).toBe(400);

      const probe = await app.inject({ method: "GET", url: "/health", remoteAddress: "203.0.113.7" });
      expect(probe.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  }, 30_000);
});
