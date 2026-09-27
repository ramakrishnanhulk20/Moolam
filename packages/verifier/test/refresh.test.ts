// Covers the index refresh: a passport registered after boot is matched once reload() has run,
// /health counts it, and a source that fails a refresh leaves the copy already loaded in place.
// From review pass 11 (V114): two loads that overlap end in the newer copy, stamped when its rows
// were read, and a timer tick is skipped while the load before it is still running.
// Requests go through fastify.inject, so no port is bound.
// Does NOT cover a real Envio source or a real interval: the timer is vitest's fake one.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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

// Review pass 11, answers #2 (V114): the timer started a load whether or not the last one had
// finished, and the load that ended last won even when its rows were the older ones.
describe("overlapping refreshes", () => {
  it("ends in the newer copy when an older load finishes last, stamped when its rows were read", async () => {
    const boot = [recordFor(await fingerprint(await makeImage(73)))];
    const later = recordFor(await fingerprint(await makeImage(74)));
    let now = 1_000_000;
    let finishOlder: (records: PassportRecord[]) => void = () => undefined;
    const loads: (() => Promise<PassportRecord[]>)[] = [];
    const source: PassportSource = { load: async () => await (loads.shift() ?? (async () => boot))() };
    const app = await buildServer({ source, logger: false, index: { refreshMs: 0, clock: () => now } });
    await app.ready();
    loads.push(
      () =>
        new Promise((resolve) => {
          finishOlder = resolve;
        }),
      async () => {
        // This load's page is read at t=3000 s and its last read ends two thousand seconds later.
        now = 5_000_000;
        return [...boot, later];
      },
    );

    try {
      now = 2_000_000;
      const older = app.verifier.reload();
      now = 3_000_000;
      await app.verifier.reload();
      now = 6_000_000;
      finishOlder([...boot]);
      await older;

      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.json().records).toBe(2);
      expect(health.json().index).toMatchObject({ loadedAt: 3_000 });
    } finally {
      await app.close();
    }
  }, 30_000);

  it("skips a refresh tick while the load before it is still running", async () => {
    const boot = [recordFor(await fingerprint(await makeImage(75)))];
    let calls = 0;
    let finish: (records: PassportRecord[]) => void = () => undefined;
    const source: PassportSource = {
      load: async () => {
        calls += 1;
        if (calls === 2) {
          return await new Promise<PassportRecord[]>((resolve) => {
            finish = resolve;
          });
        }
        return boot;
      },
    };
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const app = await buildServer({ source, logger: false, index: { refreshMs: 1_000 } });
      try {
        vi.advanceTimersByTime(3_500);
        expect(calls).toBe(2);

        finish(boot);
        await new Promise((resolve) => setImmediate(resolve));
        vi.advanceTimersByTime(1_000);
        expect(calls).toBe(3);
      } finally {
        await app.close();
      }
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);
});
