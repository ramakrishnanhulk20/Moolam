// Covers the index refresh: a passport registered after boot is matched once reload() has run,
// /health counts it, and a source that fails a refresh leaves the copy already loaded in place.
// Requests go through fastify.inject, so no port is bound.
// Does NOT cover the INDEX_REFRESH_MS timer firing on its own, which is a setInterval around the
// same reload(), and does not cover a real Envio source.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { fingerprint } from "../src/fingerprint.js";
import { buildServer } from "../src/server.js";
import type { PassportSource } from "../src/source/PassportSource.js";
import type { PassportRecord } from "../src/types.js";
import { makeImage, multipartBody, recordFor } from "./helpers.js";

describe("index refresh", () => {
  let app: FastifyInstance;
  let laterImage: Buffer;
  let held: PassportRecord[];
  let failNext = false;

  const source: PassportSource = {
    load: async () => {
      if (failNext) {
        throw new Error("the indexer is down");
      }
      return [...held];
    },
  };

  async function verify(image: Buffer): Promise<{ exact: string | null }> {
    const { payload, headers } = multipartBody("file", "a.jpg", "image/jpeg", image);
    const response = await app.inject({ method: "POST", url: "/verify", payload, headers });
    expect(response.statusCode).toBe(200);
    return response.json().result;
  }

  beforeAll(async () => {
    const first = await makeImage(71);
    laterImage = await makeImage(72);
    held = [recordFor(await fingerprint(first))];
    app = await buildServer({ source, logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("matches a passport that was registered after the service booted", async () => {
    expect((await verify(laterImage)).exact).toBeNull();

    held.push(recordFor(await fingerprint(laterImage)));
    await app.verifier.reload();

    expect((await verify(laterImage)).exact).toMatch(/^0x[0-9a-f]{64}$/);
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.json().records).toBe(2);
  }, 30_000);

  it("keeps the index it has when a refresh fails", async () => {
    failNext = true;
    await expect(app.verifier.reload()).resolves.toBeUndefined();
    failNext = false;

    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.json().records).toBe(2);
    expect((await verify(laterImage)).exact).toMatch(/^0x[0-9a-f]{64}$/);
  }, 30_000);
});
