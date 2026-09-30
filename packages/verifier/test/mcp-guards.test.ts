// Covers the guards around the MCP server: a picture URL on a private address is refused through
// the /verify fetch path (M1); an index that is behind or down, a consent read that failed and a
// chain that did not answer each give isError "unavailable", never "no match", "not stated" or an
// empty list (M3); a browser Origin that is not one of CORS_ORIGINS gets 403 while a listed one and
// a missing one pass, a preflight is told the MCP header set, and the MCP answer carries the
// service's security headers and no-store (M5); a body declared over the route's limit is refused
// before any of it is read.
// Does NOT cover DNS answers that point a public name inward (safeFetch.test.ts covers the guard
// itself), a real browser enforcing CORS, the live index or chain, or the rate limiter, which is
// the service's own per-address rule and is covered by fair-limits.test.ts.

import { request as httpRequest } from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MCP_BODY_LIMIT } from "../src/routes/mcp.js";
import { URL_UNFETCHABLE } from "../src/routes/shared.js";
import type { McpChain } from "../src/mcp/chain.js";
import { buildServer } from "../src/server.js";
import type { PassportSource } from "../src/source/PassportSource.js";
import type { Hex } from "../src/types.js";
import { makeImage } from "./helpers.js";

// env.ts reads CORS_ORIGINS once at import, so the list is set before the imports above run.
const ALLOWED = vi.hoisted(() => {
  const origin = "http://localhost:3210";
  process.env.CORS_ORIGINS = `${origin},https://moolam.example`;
  return origin;
});

const PERIOD_MS = 60_000;
const REGISTERED = `0x${"d4".repeat(32)}` as Hex;

const chain: McpChain = {
  headTime: async () => 1_790_000_000,
  passport: async (id) =>
    id === REGISTERED
      ? {
          creator: "0x1111111111111111111111111111111111111111",
          parentId: null,
          generatorAgentId: 0n,
          manifestHash: `0x${"00".repeat(32)}` as Hex,
          kind: 1,
          registeredAt: 1_700_000_000n,
          disputed: false,
          metadataURI: "ipfs://bafyregistered",
        }
      : undefined,
  holder: async () => "0x1111111111111111111111111111111111111111",
  consentAt: async () => {
    throw new Error("the chain did not answer");
  },
  agent: async () => {
    throw new Error("the chain did not answer");
  },
};

let app: FastifyInstance;
let url: URL;
let now = Date.parse("2026-09-30T12:00:00Z");
let indexDown = false;
let recentDown = true;

async function client(): Promise<Client> {
  const connected = new Client({ name: "guard-test", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await connected.connect(new StreamableHTTPClientTransport(url));
  return connected;
}

function refusal(result: { isError?: unknown; content?: unknown; structuredContent?: unknown }): string {
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toBeUndefined();
  return ((result.content as { text: string }[])[0] as { text: string }).text;
}

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } },
});

async function post(headers: Record<string, string>): Promise<Response> {
  return await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: INITIALIZE,
  });
}

describe("the MCP route's guards", () => {
  beforeAll(async () => {
    const source: PassportSource = {
      load: async () => {
        if (indexDown) {
          throw new Error("the indexer answered 503");
        }
        return [];
      },
    };
    app = await buildServer({
      source,
      logger: false,
      index: { refreshMs: PERIOD_MS, clock: () => now },
      mcp: {
        chain,
        recent: async () => {
          if (recentDown) {
            throw new Error("the index answered 503");
          }
          return [];
        },
      },
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address() as { port: number };
    url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  });

  afterAll(async () => {
    await app.close();
  });

  it("M1: refuses a picture URL on a private or loopback address with the /verify sentence", async () => {
    const connected = await client();
    for (const target of [
      "https://127.0.0.1/picture.jpg",
      "https://[::1]/picture.jpg",
      "https://169.254.169.254/latest/meta-data",
      "https://10.0.0.8/picture.jpg",
      "https://localhost/picture.jpg",
    ]) {
      const result = await connected.callTool({ name: "check_picture", arguments: { url: target } });
      expect(refusal(result), target).toBe(URL_UNFETCHABLE);
    }
    await connected.close();
  });

  it("M3: a read that failed is unavailable, never an empty list, 'not stated' or 'not found'", async () => {
    const connected = await client();
    expect(refusal(await connected.callTool({ name: "list_recent_passports", arguments: { limit: 5 } }))).toMatch(/^unavailable/);
    // Under a test runner the consent reader reaches no chain, so the statement cannot be read.
    expect(refusal(await connected.callTool({ name: "get_ai_use_terms", arguments: { passportId: REGISTERED } }))).toMatch(
      /^unavailable/,
    );
    expect(
      refusal(await connected.callTool({ name: "get_ai_use_terms", arguments: { passportId: REGISTERED, at: 1_750_000_000 } })),
    ).toMatch(/^unavailable/);
    expect(refusal(await connected.callTool({ name: "get_agent", arguments: { agentId: 42 } }))).toMatch(/^unavailable/);
    recentDown = false;
    const listed = await connected.callTool({ name: "list_recent_passports", arguments: {} });
    expect(listed.structuredContent).toMatchObject({ passports: [], index: { stale: false } });
    await connected.close();
  });

  it("M3: an index that is down gives isError for a picture that matches nothing, never 'no match'", async () => {
    const connected = await client();
    const picture = (await makeImage(311)).toString("base64");
    const fresh = await connected.callTool({ name: "check_picture", arguments: { image: picture } });
    expect(fresh.structuredContent).toMatchObject({ verdict: "no-match", passportId: null, index: { stale: false } });

    indexDown = true;
    now += 6 * PERIOD_MS;
    await app.verifier.reload();
    expect(app.verifier.indexState().stale).toBe(true);

    expect(refusal(await connected.callTool({ name: "check_picture", arguments: { image: picture } }))).toMatch(
      /^unavailable: the passport index is behind/,
    );
    expect(refusal(await connected.callTool({ name: "list_recent_passports", arguments: {} }))).toMatch(/^unavailable/);
    expect(refusal(await connected.callTool({ name: "get_history", arguments: { passportId: REGISTERED } }))).toMatch(
      /^unavailable/,
    );
    await connected.close();
  });

  it("M5: a browser Origin that is not listed gets 403; a listed one and none at all pass", async () => {
    const evil = await post({ origin: "https://evil.example" });
    expect(evil.status).toBe(403);
    expect(await evil.json()).toMatchObject({ jsonrpc: "2.0", error: { code: -32000 } });

    const opaque = await post({ origin: "null" });
    expect(opaque.status).toBe(403);

    const listed = await post({ origin: ALLOWED });
    expect(listed.status).toBe(200);
    expect(listed.headers.get("access-control-allow-origin")).toBe(ALLOWED);
    await listed.body?.cancel();

    const server = await post({});
    expect(server.status).toBe(200);
    expect(server.headers.get("x-content-type-options")).toBe("nosniff");
    expect(server.headers.get("referrer-policy")).toBe("no-referrer");
    expect(server.headers.get("strict-transport-security")).toContain("max-age=");
    expect(server.headers.get("cache-control")).toContain("no-store");
    await server.body?.cancel();
  });

  it("tells a listed origin's preflight that the MCP headers are allowed", async () => {
    const response = await app.inject({
      method: "OPTIONS",
      url: "/mcp",
      headers: {
        origin: ALLOWED,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,mcp-protocol-version,mcp-method,mcp-name",
      },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe(ALLOWED);
    const allowed = String(response.headers["access-control-allow-headers"]).toLowerCase();
    for (const header of ["content-type", "mcp-protocol-version", "mcp-method", "mcp-name"]) {
      expect(allowed).toContain(header);
    }
  });

  it("refuses a body declared over the route's limit before reading any of it, and one that is not JSON", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const sent = httpRequest(url, {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(MCP_BODY_LIMIT + 1) },
      });
      sent.on("response", (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
        sent.destroy();
      });
      sent.on("error", reject);
      sent.flushHeaders();
    });
    expect(status).toBe(413);

    const text = await fetch(url, { method: "POST", headers: { "content-type": "text/plain" }, body: "hello" });
    expect(text.status).toBe(415);
    const broken = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    expect(broken.status).toBe(400);
  });
});
