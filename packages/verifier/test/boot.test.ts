// Covers what the service refuses to do at boot and how it reads a caller's address: the proxy
// hops it will believe, the routes EXPECT_ROUTES insists on, the paid route without a base URL,
// the registry check, the match gate answering 503 when no slot comes free, and (V10) the two
// routes that read a holder's wallets from Privy staying off, with the reason, on a host without
// PRIVY_APP_SECRET, while the sealed reads stay on. From review pass 8: a signer that cannot load
// turns /prepare, /generate and /edit off with the reason on /health and leaves /verify serving
// (V73), and a registry read that fails boots with /generate answering 503 until a re-check reads
// the chain and agrees, while a chain that answers and disagrees still stops boot (V76).
// Every case that needs different settings re-imports the server with the environment stubbed,
// because src/env.ts validates once when it is first loaded.
// Does NOT cover the real registry read against Monad: the V76 cases point the real check at a
// local stand-in on 127.0.0.1 that hangs up or answers one eth_call, and the rest pass a stub. The
// 5 minute re-check interval is shortened for the test, not waited out.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { encodeFunctionResult, parseAbi, type Hex } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { RegistryUnreadable } from "../src/boot/registryChecks.js";
import { PACKAGE_ROOT } from "../src/env.js";
import { buildServer } from "../src/server.js";
import type { PassportSource } from "../src/source/PassportSource.js";
import { makeImage, multipartBody } from "./helpers.js";

type BuildOptions = NonNullable<Parameters<typeof buildServer>[0]>;

const emptySource: PassportSource = { load: async () => [] };
// Both look-alike settings, so the backlog is on and the lists of what is off below are about what
// each case changes. A host without them has the backlog off, which test/lookalike-routes.test.ts covers.
const BACKLOG_ON = { settings: { activation: 1, receiver: "0x7777777777777777777777777777777777777777" as Hex } };
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
  return await fresh.buildServer({ source: emptySource, logger: false, lookalikes: BACKLOG_ON, ...options });
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

/** A local stand-in for the chain's RPC: it hangs up on every call, or answers eth_call with `answer`. */
async function localRpc(answer?: Hex): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    if (answer === undefined) {
      request.socket.destroy();
      return;
    }
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      const call = JSON.parse(body) as { id: number };
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result: answer }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: async () => await new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * Builds a server whose registry check is the real one, reading the chain through `rpc`, from a
 * fresh module graph so the check reads the stubbed environment.
 */
async function serverCheckingRegistryAt(rpc: string, options: BuildOptions = {}): Promise<FastifyInstance> {
  for (const [name, value] of Object.entries({
    GENERATOR_WALLET_ID: "",
    GENERATOR_WALLET_ADDRESS: "",
    MONAD_MAINNET_RPC_URL: rpc,
    MONAD_RPC_FALLBACK_URL: rpc,
    X402_ENABLED: "false",
    EXPECT_ROUTES: "",
  })) {
    vi.stubEnv(name, value);
  }
  vi.resetModules();
  const fresh = await import("../src/server.js");
  const checks = await import("../src/boot/registryChecks.js");
  const { env } = await import("../src/env.js");
  return await fresh.buildServer({
    source: emptySource,
    logger: false,
    generate: {},
    lookalikes: BACKLOG_ON,
    ...options,
    checks: { registry: async () => await checks.checkRegistry(env), ...options.checks },
  });
}

async function verifiesAPicture(app: FastifyInstance): Promise<number> {
  const { payload, headers } = multipartBody("file", "a.jpg", "image/jpeg", await makeImage(82));
  return (await app.inject({ method: "POST", url: "/verify", payload, headers })).statusCode;
}

describe("V73: a signer that cannot load turns the signing routes off, not the service", () => {
  const missing = path.join(PACKAGE_ROOT, "test-assets", "certs", "not-here.pem");
  const brokenSigner = {
    PINATA_JWT: "test-token-not-a-real-pinata-jwt",
    PRIVY_APP_ID: "moolamtestapp0000009",
    PRIVY_APP_SECRET: "test-app-secret-not-a-real-one",
    MOOLAM_C2PA_CERT_PATH: missing,
    MOOLAM_C2PA_KEY_PATH: missing,
    X402_ENABLED: "false",
    EXPECT_ROUTES: "",
  };

  it("boots with /verify and the re-check queue serving, and /prepare, /generate and /edit off with the reason", async () => {
    const app = await serverWith(brokenSigner, { generate: {}, edit: {}, checks: { registry: async () => undefined } });
    await app.ready();

    try {
      expect(await verifiesAPicture(app)).toBe(200);
      expect((await app.inject({ method: "GET", url: `/recheck/status/0x${"ab".repeat(32)}` })).statusCode).not.toBe(404);
      for (const url of ["/prepare", "/generate", "/edit"]) {
        expect((await app.inject({ method: "POST", url, payload: {} })).statusCode).toBe(404);
      }
      // Unsealing does not sign, so it stays on.
      expect((await app.inject({ method: "POST", url: "/unseal" })).statusCode).toBe(401);

      const health = (await app.inject({ method: "GET", url: "/health" })).json() as {
        routes: string[];
        off: { route: string; reason: string }[];
      };
      expect(health.routes).toEqual([
        "verify",
        "mcp",
        "lookalikes/candidates",
        "lookalikes/backlog",
        "recheck",
        "unseal",
        "sealed",
        "challenges/answer",
        "decisions/reasons",
        "health",
      ]);
      expect(health.off.map((off) => off.route)).toEqual(["POST /prepare", "POST /generate", "POST /edit"]);
      expect(health.off.every((off) => /signing certificate/.test(off.reason))).toBe(true);
      expect(JSON.stringify(health)).not.toContain("not-here.pem");
    } finally {
      await app.close();
    }
  }, 60_000);

  it("still stops boot when EXPECT_ROUTES names a signing route, and names the signer", async () => {
    await expect(serverWith({ ...brokenSigner, EXPECT_ROUTES: "prepare" })).rejects.toThrow(/prepare needs .*sign/);
  }, 60_000);
});

describe("V76: a registry read that fails means not checked yet, not a dead service", () => {
  it("boots with /verify serving and /generate answering 503 generator-unchecked when the chain cannot be read", async () => {
    const rpc = await localRpc();
    const app = await serverCheckingRegistryAt(rpc.url);
    await app.ready();

    try {
      expect(await verifiesAPicture(app)).toBe(200);
      const generate = await app.inject({ method: "POST", url: "/generate", payload: {} });
      expect(generate.statusCode).toBe(503);
      expect(generate.json().error).toBe("generator-unchecked");
      expect(generate.json().reason).toMatch(/registry/);
      expect(generate.body).not.toContain("127.0.0.1");

      const health = (await app.inject({ method: "GET", url: "/health" })).json() as {
        routes: string[];
        off: { route: string; reason: string }[];
      };
      expect(health.routes).not.toContain("generate");
      expect(health.off.map((off) => off.route)).toContain("POST /generate");
    } finally {
      await app.close();
      await rpc.close();
    }
  }, 60_000);

  it("opens /generate on the next re-check that reads the chain and agrees", async () => {
    let chainUp = false;
    let reads = 0;
    const app = await buildServer({
      source: emptySource,
      logger: false,
      generate: {},
      lookalikes: BACKLOG_ON,
      checks: {
        registry: async () => {
          reads += 1;
          if (!chainUp) {
            throw new RegistryUnreadable("could not read the registry's signing domain: fetch failed");
          }
        },
        retryMs: 20,
      },
    });
    await app.ready();

    try {
      // Re-checks that still cannot read the chain keep it closed.
      await vi.waitFor(() => {
        expect(reads).toBeGreaterThanOrEqual(3);
      });
      expect((await app.inject({ method: "POST", url: "/generate", payload: {} })).statusCode).toBe(503);

      chainUp = true;
      // Open again: the route now runs its own checks, and a caller with no token is a 401.
      await vi.waitFor(async () => {
        expect((await app.inject({ method: "POST", url: "/generate", payload: {} })).statusCode).toBe(401);
      });
      expect(app.verifier.routes).toContain("generate");
      expect(app.verifier.routesOff).toEqual([]);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("still stops boot when the chain answers and disagrees", async () => {
    const wrongName = encodeFunctionResult({
      abi: parseAbi([
        "function eip712Domain() view returns (bytes1, string, string, uint256, address, bytes32, uint256[])",
      ]),
      functionName: "eip712Domain",
      result: ["0x0f", "SomeoneElse", "1", 143n, "0x0000000000000000000000000000000000000001", `0x${"00".repeat(32)}`, []],
    });
    const rpc = await localRpc(wrongName);
    try {
      await expect(serverCheckingRegistryAt(rpc.url)).rejects.toThrow(/the chain does not match/);
    } finally {
      await rpc.close();
    }
  }, 60_000);
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
    const held = [app.verifier.runVerify(() => blocked), app.verifier.runVerify(() => blocked)];

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
