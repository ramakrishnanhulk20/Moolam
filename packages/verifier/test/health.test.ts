// Covers what GET /health answers: liveness, the index size, the package version, the list of
// routes this host mounted, in the documented order, how much of the day's budget for everyone is
// gone, and that the probe is never rate-limited, since a probe that can be refused would read as
// an outage.
// The generate route and the paid route are switched off below so the list is the same on any
// machine, whatever the developer's .env happens to hold.
// Does NOT cover the routes themselves, which have their own files, and does not cover what a
// host with every key set mounts, which is the same code path with more flags true.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PassportSource } from "../src/source/PassportSource.js";

vi.hoisted(() => {
  process.env.X402_ENABLED = "false";
  process.env.GENERATOR_WALLET_ID = "";
  process.env.EXPECT_ROUTES = "";
  // Set to numbers nothing else uses, so the answer below proves these came from the environment
  // rather than from a default that happened to match.
  process.env.GLOBAL_PREPARES_PER_DAY = "7";
  process.env.GLOBAL_GENERATIONS_PER_DAY = "5";
  process.env.GLOBAL_EDITS_PER_DAY = "3";
});

const { buildServer } = await import("../src/server.js");

const emptySource: PassportSource = { load: async () => [] };

describe("GET /health", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer({ source: emptySource, logger: false, prepare: {}, edit: {} });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("answers ok with the record count and the version", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, records: 0 });
    expect(typeof response.json().version).toBe("string");
  });

  it("names the routes this host mounted, in order", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.json().routes).toEqual(["verify", "prepare", "edit", "health"]);
  });

  it("says how much of the day's budget for everyone is gone, with the ceilings from the environment", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.json().limits).toEqual({
      prepares: { used: 0, max: 7 },
      generations: { used: 0, max: 5 },
      edits: { used: 0, max: 3 },
    });
  });

  it("is never rate-limited: the 61st probe in a minute from one address still answers", async () => {
    for (let i = 0; i < 65; i += 1) {
      const response = await app.inject({ method: "GET", url: "/health", remoteAddress: "203.0.113.9" });
      expect(response.statusCode).toBe(200);
      expect(response.headers["x-ratelimit-limit"]).toBeUndefined();
    }
  });
});
