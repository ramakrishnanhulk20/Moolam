// Covers what GET /health answers: liveness, the index size, the package version and the list of
// routes this host mounted, in the documented order.
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
});
