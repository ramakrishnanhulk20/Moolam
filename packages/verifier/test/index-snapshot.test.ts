// Covers review pass 10 V101: one verify answer describes one copy of the register. The match, the
// exact lookup and the index field all read the copy the request took, so a reload that lands while
// the match is running changes none of them. The match is held at its start by a stand-in for
// matchImage that waits for the test, then runs the real one, so the reload lands at a known point.
// Does NOT cover the refresh timer firing on its own, the paid route (it takes its copy the same
// way, through the same call), or a real Envio source.

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fingerprint } from "../src/fingerprint.js";
import { buildServer } from "../src/server.js";
import type { PassportSource } from "../src/source/PassportSource.js";
import type { PassportRecord } from "../src/types.js";
import { makeImage, multipartBody, recordFor } from "./helpers.js";

const hold = vi.hoisted(() => {
  const state = {
    started: undefined as (() => void) | undefined,
    release: Promise.resolve(),
  };
  return state;
});

vi.mock("../src/match.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/match.js")>();
  return {
    ...real,
    matchImage: async (...args: Parameters<typeof real.matchImage>) => {
      hold.started?.();
      await hold.release;
      return await real.matchImage(...args);
    },
  };
});

const PERIOD_MS = 60_000;
const BOOT = Date.parse("2026-09-27T09:00:00Z");

describe("V101: a reload in the middle of a verify", () => {
  let app: FastifyInstance;
  let now = BOOT;
  let picture: Buffer;
  let record: PassportRecord;
  let held: PassportRecord[];

  const source: PassportSource = { load: async () => [...held] };

  beforeAll(async () => {
    picture = await makeImage(151);
    record = recordFor(await fingerprint(picture));
    held = [record];
    app = await buildServer({ source, logger: false, index: { refreshMs: PERIOD_MS, clock: () => now } });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("does not change that request's index field, its match or its exact lookup", async () => {
    let started!: () => void;
    const matching = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    hold.release = new Promise<void>((resolve) => {
      release = resolve;
    });
    hold.started = started;

    const { payload, headers } = multipartBody("file", "a.jpg", "image/jpeg", picture);
    const answer = app.inject({ method: "POST", url: "/verify", payload, headers });

    await matching;
    // The indexer re-syncs from its start block and the next load holds none of it yet.
    held = [];
    now = BOOT + PERIOD_MS;
    await app.verifier.reload();
    release();

    const response = await answer;
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.index).toEqual({ loadedAt: BOOT / 1000, stale: false });
    expect(body.result.exact).toBe(record.id);
    expect(body.result.best?.id).toBe(record.id);

    // The next request takes the new copy, and says so.
    hold.started = undefined;
    hold.release = Promise.resolve();
    const again = multipartBody("file", "a.jpg", "image/jpeg", picture);
    const after = await app.inject({ method: "POST", url: "/verify", payload: again.payload, headers: again.headers });
    expect(after.json().index).toEqual({ loadedAt: (BOOT + PERIOD_MS) / 1000, stale: false });
    expect(after.json().result.exact).toBeNull();
  }, 60_000);
});
