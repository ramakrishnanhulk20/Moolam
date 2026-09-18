// Covers what a caller is told when this service cannot reach the chain. The RPC address may be a
// dedicated endpoint whose path is its access token, and viem writes that address into its own
// errors, so the test proves the error viem raises does carry the address and that no route hands
// it on: /edit answers its fixed `chain-unavailable`, and the other routes answer as they always do.
// Does NOT cover the server's own log, which is private to the host and does carry the reason, and
// does NOT cover a URL the caller itself sent: /verify quotes that back in a 400 on purpose, and it
// is the caller's address, not this service's endpoint.

import { SignJWT, generateKeyPair } from "jose";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Hex } from "../src/types.js";
import { makeImage } from "./helpers.js";

/** Shaped like a QuickNode address, where the path is the credential. Nothing here is real. */
const ENDPOINT = "https://leak-canary.example/TOKEN-CANARY-7f3a";
const TOKEN = "TOKEN-CANARY-7f3a";
const ANY_ADDRESS = /https?:\/\//;

const SETTINGS = vi.hoisted(() => {
  const settings = { appId: "moolamtestapp0000004" };
  process.env.MONAD_MAINNET_RPC_URL = "https://leak-canary.example/TOKEN-CANARY-7f3a";
  process.env.PRIVY_APP_ID = settings.appId;
  process.env.PINATA_JWT = "test-token-not-a-real-pinata-jwt";
  process.env.PINATA_GATEWAY_URL = "https://moolam-test.mypinata.cloud/ipfs/";
  process.env.PRIVY_EDIT_SIGNER_ID = "moolamtesteditsigner02";
  process.env.PRIVY_EDIT_POLICY_ID = "moolamtesteditpolicy02";
  return settings;
});

// The Privy client is never reached: every request here stops at the chain read before it.
vi.mock("../src/generate/privy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/generate/privy.js")>()),
  privy: () => ({}),
  ownerContext: () => ({}),
}));

const { passportExists } = await import("../src/edit/registry.js");
const { readClient } = await import("../src/reputation/registry.js");
const { buildServer } = await import("../src/server.js");
const emptySource = { load: async () => [] };

const PARENT = `0x${"ab".repeat(32)}` as Hex;
const REGISTRY = `0x${"cd".repeat(20)}` as Hex;

let signing: CryptoKey;
let verifying: CryptoKey;
let app: FastifyInstance;
let picture: Buffer;

async function token(subject: string): Promise<string> {
  return await new SignJWT({})
    .setProtectedHeader({ alg: "ES256" })
    .setIssuer("privy.io")
    .setAudience(SETTINGS.appId)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(signing);
}

function editBody(fields: Record<string, string>, content: Buffer): {
  payload: Buffer;
  headers: Record<string, string>;
} {
  const boundary = "----moolamleaktest";
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="edited.jpg"\r\n` +
        "Content-Type: image/jpeg\r\n\r\n",
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return { payload: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

beforeAll(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  signing = pair.privateKey;
  verifying = pair.publicKey;
  picture = await makeImage(21);

  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith("https://leak-canary.example")) {
      throw new TypeError("fetch failed");
    }
    return await realFetch(input, init);
  });

  app = await buildServer({ source: emptySource, logger: false, edit: { keys: verifying } });
  await app.ready();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await app.close();
});

describe("an endpoint this service cannot reach", () => {
  it("raises an error that carries the endpoint's whole address", async () => {
    const thrown = await passportExists(readClient(), REGISTRY, PARENT).then(
      () => null,
      (error: unknown) => error as Error,
    );

    expect(thrown).not.toBeNull();
    expect(thrown?.message).toContain(TOKEN);
  });

  it("tells an editing caller the chain is unavailable and nothing else", async () => {
    const { payload, headers } = editBody(
      { title: "Monsoon nets, brightened", parentId: PARENT, note: "brightened the sky" },
      picture,
    );

    const response = await app.inject({
      method: "POST",
      url: "/edit",
      payload,
      headers: { ...headers, authorization: `Bearer ${await token("did:privy:leak-test")}` },
      remoteAddress: "203.0.113.42",
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "chain-unavailable" });
    expect(response.body).not.toContain(TOKEN);
    expect(response.body).not.toMatch(ANY_ADDRESS);
  });

  it("keeps every other answer free of an address too", async () => {
    const asked = [
      await app.inject({ method: "GET", url: "/health" }),
      await app.inject({ method: "GET", url: "/nowhere" }),
      await app.inject({ method: "POST", url: "/verify", payload: {} }),
      await app.inject({ method: "POST", url: "/edit", payload: {} }),
    ];

    for (const response of asked) {
      expect(response.body).not.toContain(TOKEN);
      expect(response.body).not.toMatch(ANY_ADDRESS);
    }
  });
});
