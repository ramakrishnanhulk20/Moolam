// Covers review pass 9 V85: the router decodes a percent-encoded path before it matches a route, so
// POST /%70repare runs the /prepare handler and GET /%75nseal/<id> runs the unseal read. Whether an
// answer may be cached was judged on the raw path, so those spellings went out without no-store.
// It is now judged on the route that matched, and on the decoded path for a 404.
// Does NOT cover a real proxy or browser cache honouring the header, and does not reach past the
// token check or the id check: the header is decided by the route, not by how far a request got.

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.PRIVY_APP_ID = "moolamtestapp0000085";
  process.env.PINATA_JWT = "test-token-not-a-real-pinata-jwt";
  process.env.PINATA_GATEWAY_URL = "https://moolam-test.mypinata.cloud/ipfs/";
  process.env.EXPECT_ROUTES = "";
  process.env.X402_ENABLED = "false";
});

const { buildServer } = await import("../src/server.js");

describe("V85: an encoded spelling of a sealed or runner path", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer({ source: { load: async () => [] }, logger: false, prepare: {} });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("POST /%70repare reaches /prepare and carries cache-control no-store", async () => {
    const response = await app.inject({ method: "POST", url: "/%70repare" });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "unauthorized" });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("GET /%75nseal/<id> reaches the unseal read and carries cache-control no-store", async () => {
    const response = await app.inject({ method: "GET", url: "/%75nseal/not-a-passport-id" });

    expect(response.statusCode).toBe(400);
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("GET /rech%65ck/queue reaches the runner's queue read and carries cache-control no-store", async () => {
    const response = await app.inject({ method: "GET", url: "/rech%65ck/queue" });

    expect(response.statusCode).not.toBe(404);
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("a 404 under an encoded /unseal spelling is judged by its decoded path", async () => {
    const response = await app.inject({ method: "GET", url: "/%75nseal" });

    expect(response.statusCode).toBe(404);
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("leaves a cacheable route cacheable, however it is spelled", async () => {
    const response = await app.inject({ method: "GET", url: "/h%65alth" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBeUndefined();
  });
});
