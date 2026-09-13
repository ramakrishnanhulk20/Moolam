// Covers POST /edit with Privy, the chain reads and Pinata all stubbed: a request with no token
// stopping before anything is read, the two refusals a browser has to act on (no signer, not the
// owner), an unknown parent, the daily allowance on a fake clock, and the happy path, where what
// matters is the calldata that would reach the chain and the hash the answer carries back.
// Does NOT cover Privy actually signing, gas sponsorship, or the registry accepting the edit.
// Those are proven live by packages/agents/scripts/prove-privy.ts step 6 and, from the browser,
// by a real creator granting a signer.

import { SignJWT, generateKeyPair } from "jose";
import { decodeFunctionData, getAddress, type Hex } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { makeImage } from "./helpers.js";

// env.ts validates once at import, so everything the route reads has to be set before any module
// in this file loads. vi.hoisted runs before the imports above. The Pinata token is a fake: every
// call to Pinata is answered by the stub below.
const SETTINGS = vi.hoisted(() => {
  const settings = {
    appId: "moolamtestapp0000003",
    signerId: "moolamtesteditsigner01",
    policyId: "moolamtesteditpolicy01",
  };
  process.env.PRIVY_APP_ID = settings.appId;
  process.env.PINATA_JWT = "test-token-not-a-real-pinata-jwt";
  process.env.PINATA_GATEWAY_URL = "https://moolam-test.mypinata.cloud/ipfs/";
  process.env.PRIVY_EDIT_SIGNER_ID = settings.signerId;
  process.env.PRIVY_EDIT_POLICY_ID = settings.policyId;
  process.env.EDITS_PER_DAY = "2";
  return settings;
});

const stubs = vi.hoisted(() => ({
  delegatedWallet: vi.fn(),
  walletSigners: vi.fn(),
  passportExists: vi.fn(),
  parentOwner: vi.fn(),
  estimateEditGas: vi.fn(),
  send: vi.fn(),
}));

vi.mock("../src/edit/signers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/edit/signers.js")>()),
  delegatedWallet: stubs.delegatedWallet,
  walletSigners: stubs.walletSigners,
}));

vi.mock("../src/edit/registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/edit/registry.js")>()),
  passportExists: stubs.passportExists,
  parentOwner: stubs.parentOwner,
  estimateEditGas: stubs.estimateEditGas,
}));

vi.mock("../src/edit/send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/edit/send.js")>()),
  sendFromWallet: stubs.send,
}));

// The Privy client is never called in these tests: every function that would use it is stubbed
// above. This keeps the route from building a real one out of the root .env.
vi.mock("../src/generate/privy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/generate/privy.js")>()),
  privy: () => ({}),
  ownerContext: () => ({}),
}));

const { registryEditAbi } = await import("../src/edit/registry.js");
const { buildServer } = await import("../src/server.js");
const emptySource = { load: async () => [] };

const UPLOAD_URL = "https://uploads.pinata.cloud/v3/files";
const OWNER = getAddress("0x85a88ca81ff5f681d96ab86fa60ccb8452a139a6");
const STRANGER = getAddress("0x1111111111111111111111111111111111111111");
const PARENT = `0x${"ab".repeat(32)}` as Hex;
const HASH = `0x${"11".repeat(32)}` as Hex;

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

/** A multipart body with the edited picture and the three text fields the route reads. */
function editBody(
  fields: Record<string, string>,
  content: Buffer,
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = "----moolameditest";
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`),
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="edited.jpg"\r\n` +
        `Content-Type: image/jpeg\r\n\r\n`,
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return {
    payload: Buffer.concat(parts),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

async function ask(
  subject: string,
  fields: Record<string, string>,
  options: { auth?: boolean; image?: Buffer } = {},
) {
  const { payload, headers } = editBody(fields, options.image ?? picture);
  return await app.inject({
    method: "POST",
    url: "/edit",
    payload,
    headers: {
      ...headers,
      ...(options.auth === false ? {} : { authorization: `Bearer ${await token(subject)}` }),
    },
    remoteAddress: "203.0.113.41",
  });
}

function goodFields(note = "brightened the sky") {
  return { title: "Monsoon nets, brightened", parentId: PARENT, note };
}

describe("POST /edit", () => {
  beforeAll(async () => {
    const pair = await generateKeyPair("ES256", { extractable: true });
    signing = pair.privateKey;
    verifying = pair.publicKey;
    picture = await makeImage(12);

    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== UPLOAD_URL) {
        return await realFetch(input, init);
      }
      const form = init?.body as FormData;
      const file = form.get("file") as File;
      const bytes = Buffer.from(await file.arrayBuffer());
      return new Response(JSON.stringify({ data: { cid: `bafyedit${bytes.length}`, size: bytes.length } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    app = await buildServer({ source: emptySource, logger: false, edit: { keys: verifying } });
    await app.ready();
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    await app.close();
  });

  beforeEach(() => {
    stubs.passportExists.mockReset().mockResolvedValue(true);
    stubs.delegatedWallet.mockReset().mockResolvedValue({ id: "privy-wallet-1", address: OWNER });
    stubs.walletSigners
      .mockReset()
      .mockResolvedValue([{ signerId: SETTINGS.signerId, policyIds: [SETTINGS.policyId] }]);
    stubs.parentOwner.mockReset().mockResolvedValue(OWNER);
    stubs.estimateEditGas.mockReset().mockResolvedValue(420_000n);
    stubs.send
      .mockReset()
      .mockResolvedValue({ hash: HASH, sponsored: true, transactionId: "privy-tx-1" });
  });

  it("refuses a request with no token before it reads the chain or Privy", async () => {
    const response = await ask("did:privy:no-token", goodFields(), { auth: false });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "unauthorized" });
    expect(stubs.passportExists).not.toHaveBeenCalled();
    expect(stubs.delegatedWallet).not.toHaveBeenCalled();
  });

  it("answers 409 no-signer when the creator has granted no wallet this app can sign on", async () => {
    stubs.delegatedWallet.mockResolvedValueOnce(undefined);

    const response = await ask("did:privy:no-signer-user", goodFields());

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "no-signer" });
    expect(stubs.send).not.toHaveBeenCalled();
  });

  it("answers 403 not-owner when the parent belongs to another address", async () => {
    stubs.parentOwner.mockResolvedValueOnce(STRANGER);

    const response = await ask("did:privy:not-owner-user", goodFields());

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "not-owner" });
    expect(stubs.send).not.toHaveBeenCalled();
  });

  it("answers 404 no-parent for a passport id the registry does not hold", async () => {
    stubs.passportExists.mockResolvedValueOnce(false);

    const response = await ask("did:privy:no-parent-user", goodFields());

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "no-parent" });
    expect(stubs.delegatedWallet).not.toHaveBeenCalled();
  });

  it("refuses a bad parent id, a missing title and an over-long note", async () => {
    const bodies = [
      { ...goodFields(), parentId: "0xnothex" },
      { ...goodFields(), title: "" },
      { ...goodFields(), note: "x".repeat(281) },
    ];

    for (const fields of bodies) {
      const response = await ask("did:privy:bad-fields", fields);
      expect(response.statusCode, JSON.stringify(fields).slice(0, 80)).toBe(400);
    }
    expect(stubs.send).not.toHaveBeenCalled();
  });

  it("stops a creator at EDITS_PER_DAY and lets them back in a day later", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-13T09:00:00Z"));
    const user = "did:privy:quota-user";

    expect((await ask(user, goodFields("first"))).statusCode).toBe(200);
    expect((await ask(user, goodFields("second"))).statusCode).toBe(200);

    const sendsBefore = stubs.send.mock.calls.length;
    const refused = await ask(user, goodFields("third"));
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error).toBe("quota");
    expect(refused.json().quota).toEqual({ used: 2, limit: 2, resetsAt: expect.any(Number) });
    expect(stubs.send.mock.calls.length).toBe(sendsBefore);

    // The count is per verified user id, so another creator is untouched by it.
    expect((await ask("did:privy:other-user", goodFields())).statusCode).toBe(200);

    vi.setSystemTime(new Date("2026-09-14T09:00:01Z"));
    expect((await ask(user, goodFields("next day"))).statusCode).toBe(200);
    vi.useRealTimers();
  }, 120_000);

  it("sends appendEdit for the child passport and answers with the hash Privy returned", async () => {
    const response = await ask("did:privy:edit-user", goodFields("cropped the mast out"));

    expect(response.statusCode).toBe(200);
    const answer = response.json();

    expect(stubs.send).toHaveBeenCalledTimes(1);
    const sent = stubs.send.mock.calls[0]?.[2] as { to: Hex; data: Hex; gasLimit: bigint; sponsor: boolean };
    const call = decodeFunctionData({ abi: registryEditAbi, data: sent.data });
    expect(call.functionName).toBe("appendEdit");

    const [input, generatorSig] = call.args as unknown as [Record<string, unknown>, Hex];
    expect(input.parentId).toBe(PARENT);
    expect(input.creator).toBe(OWNER);
    expect(input.exactHash).toBe(answer.child.exactHash);
    expect(input.kind).toBe(2);
    expect(input.generatorAgentId).toBe(0n);
    expect(generatorSig).toBe("0x");
    expect(sent.sponsor).toBe(true);
    expect(sent.gasLimit).toBe(420_000n);

    expect(answer.hash).toBe(HASH);
    expect(answer.sponsored).toBe(true);
    expect(answer.tokenId).toBe(BigInt(answer.child.exactHash as Hex).toString());
    expect(answer.child.parentId).toBe(PARENT);
    expect(answer.child.creator).toBe(OWNER);
    expect(answer.manifest).toEqual({ embedded: true });
    expect(answer.quota).toEqual({ used: 1, limit: 2, resetsAt: expect.any(Number) });
    expect(answer.image.gatewayUrl).toMatch(/^https:\/\/moolam-test\.mypinata\.cloud\/ipfs\//);
    expect(JSON.stringify(answer)).not.toContain("test-token-not-a-real-pinata-jwt");
  }, 60_000);
});
