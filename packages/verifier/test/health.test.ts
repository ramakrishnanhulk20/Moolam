// Covers what GET /health answers: liveness, the index size, the package version, the list of
// routes this host mounted, in the documented order with /mcp, the two look-alike routes, the
// re-check queue, the four platform routes and the challenge answer among them, how much of the day's budget for everyone is gone, the private copy sweep's mode and last
// run, and that the probe is never rate-limited, since a probe that can be refused would read as
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
  process.env.GLOBAL_UNSEALS_PER_DAY = "9";
  process.env.GLOBAL_LINKS_PER_DAY = "11";
  process.env.PRIVATE_SWEEP = "";
  // POST /unseal and POST /sealed/forget read the holder's wallets from Privy, which needs the app
  // secret; set here so the list below does not depend on the developer's own .env.
  process.env.PRIVY_APP_SECRET = "test-app-secret-not-a-real-one";
  // The challenge answer routes ride on a pin token, so the list does not depend on the .env either.
  process.env.PINATA_JWT = "test-token-not-a-real-pinata-jwt";
});

const { buildServer } = await import("../src/server.js");

const emptySource: PassportSource = { load: async () => [] };

describe("GET /health", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    // The platform routes are mounted through options, with the bundled list, for the same reason.
    app = await buildServer({
      source: emptySource,
      logger: false,
      prepare: {},
      edit: {},
      platform: {},
      // Both look-alike settings, so the backlog is on and the list below does not depend on the .env.
      lookalikes: { settings: { activation: 1, receiver: "0x7777777777777777777777777777777777777777" } },
    });
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
    expect(response.json().routes).toEqual([
      "verify",
      "mcp",
      "lookalikes/candidates",
      "lookalikes/backlog",
      "recheck",
      "prepare",
      "edit",
      "unseal",
      "sealed",
      "platform/prepare",
      "platform/record",
      "platform/sign",
      "platform/status",
      "challenges/answer",
      "decisions/reasons",
      "health",
    ]);
  });

  it("says how much of the day's budget for everyone is gone, with the ceilings from the environment", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.json().limits).toEqual({
      prepares: { used: 0, max: 7 },
      generations: { used: 0, max: 5 },
      edits: { used: 0, max: 3 },
      unseals: { used: 0, max: 9 },
      links: { used: 0, max: 11 },
    });
  });

  it("shows the sweep's mode, dry by default, and after a run its time and counts with no file named", async () => {
    expect((await app.inject({ method: "GET", url: "/health" })).json().sweep).toEqual({ mode: "dry", lastRun: null });

    const at = Date.parse("2026-09-23T12:00:00Z");
    const orphan = `0x${"0c".repeat(32)}`;
    const swept = await buildServer({
      source: emptySource,
      logger: false,
      prepare: {},
      sweep: {
        mode: "delete",
        deps: {
          list: async () => ({
            files: [{ id: "0199a3c2-5d7e-7f10-9a1b-00000000000c", name: `sealed-thumb-${orphan}.jpg`, cid: "bafkreiprivate0c", createdAt: "2026-09-20T12:00:00Z" }],
            next: undefined,
          }),
          registered: async () => false,
          remove: async () => undefined,
          now: () => at,
        },
      },
    });
    try {
      await swept.privateSweep.runOnce();
      const body = (await swept.inject({ method: "GET", url: "/health" })).json();

      expect(body.sweep).toEqual({
        mode: "delete",
        lastRun: {
          at: "2026-09-23T12:00:00.000Z",
          mode: "delete",
          outcome: "finished",
          more: false,
          counts: { listed: 1, oddNames: 0, undated: 0, young: 0, registered: 0, marked: 1, deleted: 1, failed: 0 },
        },
      });
      expect(JSON.stringify(body)).not.toContain("sealed-thumb-");
      expect(JSON.stringify(body)).not.toContain("0199a3c2");
    } finally {
      await swept.close();
    }
  });

  it("is never rate-limited: the 61st probe in a minute from one address still answers", async () => {
    for (let i = 0; i < 65; i += 1) {
      const response = await app.inject({ method: "GET", url: "/health", remoteAddress: "203.0.113.9" });
      expect(response.statusCode).toBe(200);
      expect(response.headers["x-ratelimit-limit"]).toBeUndefined();
    }
  });
});
