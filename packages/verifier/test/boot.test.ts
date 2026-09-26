// Covers what the service refuses to do at boot and how it reads a caller's address: the proxy
// hops it will believe, the routes EXPECT_ROUTES insists on, the paid route without a base URL,
// the registry check, the match gate answering 503 when no slot comes free, and (V10) the two
// routes that read a holder's wallets from Privy staying off, with the reason, on a host without
// PRIVY_APP_SECRET, while the sealed reads stay on.
// Every case that needs different settings re-imports the server with the environment stubbed,
// because src/env.ts validates once when it is first loaded.
// Does NOT cover the real registry read in src/boot/registryChecks.ts, which talks to Monad: the
// check is passed in as a stub here.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import type { PassportSource } from "../src/source/PassportSource.js";
import { makeImage, multipartBody } from "./helpers.js";

type BuildOptions = NonNullable<Parameters<typeof buildServer>[0]>;

const emptySource: PassportSource = { load: async () => [] };
const PAY_TO = "0x1111111111111111111111111111111111111111";

/**
 * Builds a server from a fresh module graph with `vars` in the environment.
 *
 * GENERATOR_WALLET_ID is blanked unless a case sets it, so the generate route never mounts from a
 * developer's own .env and the registry check never reaches for the chain.
 */
async function serverWith(vars: Record<string, string>, options: BuildOptions = {}): Promise<FastifyInstance> {
  for (const [name, value] of Object.entries({ GENERATOR_WALLET_ID: "", ...vars })) {
    vi.stubEnv(name, value);
  }
  vi.resetModules();
  const fresh = await import("../src/server.js");
  return await fresh.buildServer({ source: emptySource, logger: false, ...options });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("trusted proxies", () => {
  it("takes the forwarded address only when TRUST_PROXY names the hop it came from", async () => {
    const forwarded = await serverWith({ TRUST_PROXY: "loopback" });
    const socketOnly = await serverWith({ TRUST_PROXY: "" });

    try {
      const seen: Record<string, string> = {};
      forwarded.addHook("onRequest", async (request) => {
        seen.forwarded = request.ip;
      });
      socketOnly.addHook("onRequest", async (request) => {
        seen.socketOnly = request.ip;
      });
      await forwarded.ready();
      await socketOnly.ready();

      const call = { method: "GET" as const, url: "/health", remoteAddress: "127.0.0.1", headers: { "x-forwarded-for": "203.0.113.9" } };
      await forwarded.inject(call);
      await socketOnly.inject(call);

      expect(seen.forwarded).toBe("203.0.113.9");
      expect(seen.socketOnly).toBe("127.0.0.1");
    } finally {
      await forwarded.close();
      await socketOnly.close();
    }
  });
});

describe("boot refusals", () => {
  it("names every variable missing for every route EXPECT_ROUTES asks for", async () => {
    await expect(serverWith({ EXPECT_ROUTES: "edit", PRIVY_EDIT_SIGNER_ID: "" })).rejects.toThrow(
      /PRIVY_EDIT_SIGNER_ID/,
    );

    const both = serverWith({ EXPECT_ROUTES: "edit,generate", PRIVY_EDIT_SIGNER_ID: "" });
    await expect(both).rejects.toThrow(/PRIVY_EDIT_SIGNER_ID/);
    await expect(both).rejects.toThrow(/GENERATOR_WALLET_ID/);
  });

  it("refuses the paid route when the host does not know its own URL", async () => {
    await expect(
      serverWith({ X402_ENABLED: "true", X402_PAY_TO_ADDRESS: PAY_TO, VERIFIER_BASE_URL: "" }),
    ).rejects.toThrow(/VERIFIER_BASE_URL/);
  });

  it("stops when the registry check fails and builds when it passes", async () => {
    await expect(
      buildServer({
        source: emptySource,
        logger: false,
        generate: {},
        checks: {
          registry: async () => {
            throw new Error("the chain does not match this host's settings: agent 10249 is owned by someone else");
          },
        },
      }),
    ).rejects.toThrow(/the chain does not match/);

    const app = await buildServer({
      source: emptySource,
      logger: false,
      generate: {},
      checks: { registry: async () => undefined },
    });
    await app.ready();
    expect(app.verifier.routes).toContain("generate");
    await app.close();
  });
});

describe("routes that read a holder's wallets from Privy (V10)", () => {
  /** A host that can pin and check creators, and has no Privy app secret. */
  const studioOnly = {
    PRIVY_APP_ID: "moolamtestapp0000009",
    PINATA_JWT: "test-token-not-a-real-pinata-jwt",
    PRIVY_APP_SECRET: "",
    PRIVY_AUTHORIZATION_KEY: "",
    PRIVY_EDIT_SIGNER_ID: "",
    X402_ENABLED: "false",
    EXPECT_ROUTES: "",
  };

  it("leaves POST /unseal and POST /sealed/forget off without PRIVY_APP_SECRET, says why, and keeps the sealed reads on", async () => {
    const app = await serverWith(studioOnly);
    await app.ready();

    try {
      const unseal = await app.inject({ method: "POST", url: "/unseal" });
      const forget = await app.inject({ method: "POST", url: "/sealed/forget", payload: {} });
      expect(unseal.statusCode).toBe(404);
      expect(forget.statusCode).toBe(404);

      expect((await app.inject({ method: "GET", url: "/unseal/0xnothex" })).statusCode).toBe(400);
      expect((await app.inject({ method: "GET", url: "/sealed/status/0xnothex" })).statusCode).toBe(400);

      const health = (await app.inject({ method: "GET", url: "/health" })).json() as { routes: string[] };
      expect(health.routes).toContain("sealed");
      expect(health.routes).not.toContain("unseal");
      expect(app.verifier.routesOff.map((off) => off.route)).toEqual(["POST /unseal", "POST /sealed/forget"]);
      expect(app.verifier.routesOff.every((off) => off.reason.includes("PRIVY_APP_SECRET"))).toBe(true);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("mounts both with the app secret alone, and reads users without PRIVY_AUTHORIZATION_KEY", async () => {
    const app = await serverWith({ ...studioOnly, PRIVY_APP_SECRET: "test-app-secret-not-a-real-one" });
    await app.ready();

    try {
      expect((await app.inject({ method: "POST", url: "/unseal" })).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url: "/sealed/forget", payload: {} })).statusCode).toBe(401);
      expect(app.verifier.routes).toContain("unseal");
      expect(app.verifier.routesOff).toEqual([]);

      const privy = await import("../src/generate/privy.js");
      expect(() => privy.privy()).not.toThrow();
      expect(() => privy.ownerContext()).toThrow(/PRIVY_AUTHORIZATION_KEY/);
    } finally {
      await app.close();
    }
  }, 30_000);
});

describe("the match gate", () => {
  it("answers 503 busy when no matching slot comes free in time", async () => {
    const app = await serverWith({ MATCH_WAIT_MS: "60" });
    await app.ready();

    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = [app.verifier.runPrepare(() => blocked), app.verifier.runPrepare(() => blocked)];

    try {
      const { payload, headers } = multipartBody("file", "a.jpg", "image/jpeg", await makeImage(81));
      const response = await app.inject({ method: "POST", url: "/verify", payload, headers });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: "busy" });
    } finally {
      release();
      await Promise.all(held);
      await app.close();
    }
  }, 30_000);
});
