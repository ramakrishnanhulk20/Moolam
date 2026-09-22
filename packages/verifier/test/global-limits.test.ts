// Covers the day's ceiling for everyone on the three routes that spend money, with Pinata, the
// image model, the chain reads and Privy all stubbed: a caller with no token never touches the
// budget, each route lets one through and then refuses the world with 429 global-limit, a refusal
// pins nothing and draws nothing, a refusal does not eat the caller's own allowance, a sealed
// request is still uncacheable when it is refused, and /health reports the counts and the
// ceilings.
// The ceilings here are one per action, set in the environment below, so one request each reaches
// them. The counter itself, midnight and the give-back are unit tested in test/globalDay.test.ts.
// Does NOT cover a real pin, a real drawing, a real chain read or a real send, and does not cover
// two copies of the service, which count separately by design.

import { SignJWT, generateKeyPair } from "jose";
import { getAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { makeImage } from "./helpers.js";

// env.ts validates once at import, so everything the routes read has to be set before any module
// in this file loads. vi.hoisted runs before the imports above. The Pinata token is a fake: every
// call to Pinata is answered by the stub below. The per-user allowances are two and the ceilings
// for everyone are one, which is what makes a refusal here provably the global one.
const SETTINGS = vi.hoisted(() => {
  const settings = {
    appId: "moolamtestapp0000005",
    signerId: "moolamtesteditsigner03",
    policyId: "moolamtesteditpolicy03",
  };
  process.env.PRIVY_APP_ID = settings.appId;
  process.env.PINATA_JWT = "test-token-not-a-real-pinata-jwt";
  process.env.PINATA_GATEWAY_URL = "https://moolam-test.mypinata.cloud/ipfs/";
  process.env.PRIVY_EDIT_SIGNER_ID = settings.signerId;
  process.env.PRIVY_EDIT_POLICY_ID = settings.policyId;
  process.env.GENERATE_PER_DAY = "2";
  process.env.EDITS_PER_DAY = "2";
  process.env.GLOBAL_PREPARES_PER_DAY = "1";
  process.env.GLOBAL_GENERATIONS_PER_DAY = "1";
  process.env.GLOBAL_EDITS_PER_DAY = "1";
  process.env.EXPECT_ROUTES = "";
  process.env.X402_ENABLED = "false";
  return settings;
});

const stubs = vi.hoisted(() => ({
  ensureSigner: vi.fn(),
  passportExists: vi.fn(),
  parentOwner: vi.fn(),
  estimateEditGas: vi.fn(),
  delegatedWallets: vi.fn(),
  walletSigners: vi.fn(),
  send: vi.fn(),
  receipt: vi.fn(),
  createImage: vi.fn(),
  embeddedWallets: vi.fn(),
  generatorWallet: vi.fn(),
  signAsGenerator: vi.fn(),
}));

vi.mock("../src/c2pa.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/c2pa.js")>()),
  ensureSigner: stubs.ensureSigner,
}));

vi.mock("../src/edit/registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/edit/registry.js")>()),
  passportExists: stubs.passportExists,
  parentOwner: stubs.parentOwner,
  estimateEditGas: stubs.estimateEditGas,
}));

vi.mock("../src/edit/signers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/edit/signers.js")>()),
  delegatedWallets: stubs.delegatedWallets,
  walletSigners: stubs.walletSigners,
}));

vi.mock("../src/edit/send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/edit/send.js")>()),
  sendFromWallet: stubs.send,
  awaitReceipt: stubs.receipt,
}));

vi.mock("../src/auth/wallet.js", () => ({ embeddedWallets: stubs.embeddedWallets }));

vi.mock("../src/generate/imageModel.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/generate/imageModel.js")>()),
  createImage: stubs.createImage,
}));

vi.mock("../src/generate/generatorSigner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/generate/generatorSigner.js")>()),
  generatorWallet: stubs.generatorWallet,
  signPassportAsGenerator: stubs.signAsGenerator,
}));

// Nothing here calls Privy: every function that would is stubbed above. This keeps the routes from
// building a real client out of the root .env.
vi.mock("../src/generate/privy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/generate/privy.js")>()),
  privy: () => ({}),
  ownerContext: () => ({}),
}));

const { buildServer } = await import("../src/server.js");

const UPLOAD_URL = "https://uploads.pinata.cloud/v3/files";
const PARENT = `0x${"cd".repeat(32)}` as Hex;
const HASH = `0x${"22".repeat(32)}` as Hex;
const OWNER = getAddress("0x85a88ca81ff5f681d96ab86fa60ccb8452a139a6");
const emptySource = { load: async () => [] };

/** How many files have been pinned since the stub was installed, so a refusal can prove it spent nothing. */
let pins = 0;
let signing: CryptoKey;
let verifying: CryptoKey;
let agent: PrivateKeyAccount;
let picture: Buffer;
let app: FastifyInstance;

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

function multipart(fields: Record<string, string>, content: Buffer): {
  payload: Buffer;
  headers: Record<string, string>;
} {
  const boundary = "----moolamglobal";
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="picture.jpg"\r\n` +
        `Content-Type: image/jpeg\r\n\r\n`,
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return { payload: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

async function prepare(user: string, fields: Record<string, string> = {}, auth = true) {
  const { payload, headers } = multipart({ title: "Nets at dawn", kind: "human", ...fields }, picture);
  return await app.inject({
    method: "POST",
    url: "/prepare",
    payload,
    headers: { ...headers, ...(auth ? { authorization: `Bearer ${await token(user)}` } : {}) },
    remoteAddress: "203.0.113.60",
  });
}

async function generate(user: string, title: string, auth = true) {
  return await app.inject({
    method: "POST",
    url: "/generate",
    payload: {
      prompt: "A lighthouse in a monsoon storm, painted in thick oils",
      title,
      creator: OWNER,
      deadline: Math.floor(Date.now() / 1000) + 1800,
    },
    headers: auth ? { authorization: `Bearer ${await token(user)}` } : {},
    remoteAddress: "203.0.113.61",
  });
}

async function edit(user: string, note: string, auth = true) {
  const { payload, headers } = multipart({ title: "Nets, brightened", parentId: PARENT, note }, picture);
  return await app.inject({
    method: "POST",
    url: "/edit",
    payload,
    headers: { ...headers, ...(auth ? { authorization: `Bearer ${await token(user)}` } : {}) },
    remoteAddress: "203.0.113.62",
  });
}

async function limits(): Promise<Record<string, { used: number; max: number }>> {
  const response = await app.inject({ method: "GET", url: "/health" });
  return response.json().limits as Record<string, { used: number; max: number }>;
}

/** Everything a refusal has to say: the code, the words, the counts and when it opens again. */
function expectRefused(response: Awaited<ReturnType<typeof prepare>>, max: number): void {
  expect(response.statusCode).toBe(429);
  const body = response.json();
  expect(body.error).toBe("global-limit");
  expect(body.reason).toBe(
    "Moolam has reached today's limit for this action for everyone. It opens again at midnight UTC.",
  );
  expect(body.quota).toEqual({ used: max, limit: max, resetsAt: expect.any(Number) });

  const seconds = Number(response.headers["retry-after"]);
  const untilMidnight = (body.quota.resetsAt as number) - Math.floor(Date.now() / 1000);
  expect(seconds).toBeGreaterThan(0);
  expect(seconds).toBeLessThanOrEqual(24 * 60 * 60);
  expect(Math.abs(seconds - untilMidnight)).toBeLessThanOrEqual(1);
}

describe("the day's ceiling for everyone", () => {
  beforeAll(async () => {
    const pair = await generateKeyPair("ES256", { extractable: true });
    signing = pair.privateKey;
    verifying = pair.publicKey;
    agent = privateKeyToAccount(generatePrivateKey());
    picture = await makeImage(31);

    stubs.ensureSigner.mockResolvedValue(undefined);
    // The parent is registered and the child never is, which is what a first edit needs.
    stubs.passportExists.mockImplementation(async (_chain: unknown, _registry: Hex, id: Hex) => id === PARENT);
    stubs.parentOwner.mockResolvedValue(OWNER);
    stubs.estimateEditGas.mockResolvedValue(420_000n);
    stubs.delegatedWallets.mockResolvedValue([{ id: "privy-wallet-1", address: OWNER }]);
    stubs.walletSigners.mockResolvedValue([{ signerId: SETTINGS.signerId, policyIds: [SETTINGS.policyId] }]);
    stubs.send.mockResolvedValue({ hash: HASH, sponsored: true, transactionId: "privy-tx-1" });
    stubs.receipt.mockResolvedValue({ status: "success" });
    stubs.embeddedWallets.mockResolvedValue([OWNER]);
    stubs.generatorWallet.mockResolvedValue({ id: "moolam-test-generator", address: agent.address });
    stubs.signAsGenerator.mockResolvedValue(`0x${"11".repeat(65)}`);
    stubs.createImage.mockImplementation(async (prompt: string) => ({
      bytes: await makeImage(prompt.length % 40),
      model: "gpt-image-1-mini",
      promptUsed: prompt,
    }));

    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== UPLOAD_URL) {
        return await realFetch(input, init);
      }
      pins += 1;
      const form = init?.body as FormData;
      const file = form.get("file") as File;
      const bytes = Buffer.from(await file.arrayBuffer());
      return new Response(JSON.stringify({ data: { cid: `bafyglobal${pins}`, size: bytes.length } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    app = await buildServer({
      source: emptySource,
      logger: false,
      prepare: { keys: verifying },
      generate: { keys: verifying },
      edit: { keys: verifying },
    });
    await app.ready();
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await app.close();
  });

  it("lets nobody without a token near the budget", async () => {
    const drawnBefore = stubs.createImage.mock.calls.length;

    expect((await prepare("did:privy:no-token", {}, false)).statusCode).toBe(401);
    expect((await generate("did:privy:no-token", "No token", false)).statusCode).toBe(401);
    expect((await edit("did:privy:no-token", "no token", false)).statusCode).toBe(401);

    expect(await limits()).toEqual({
      prepares: { used: 0, max: 1 },
      generations: { used: 0, max: 1 },
      edits: { used: 0, max: 1 },
    });
    expect(pins).toBe(0);
    expect(stubs.createImage.mock.calls.length).toBe(drawnBefore);
  }, 30_000);

  it("takes one prepare for the whole world and refuses the next, pinning nothing", async () => {
    const first = await prepare("did:privy:prepare-one");
    expect(first.statusCode).toBe(200);
    expect((await limits()).prepares).toEqual({ used: 1, max: 1 });

    const pinnedSoFar = pins;
    const refused = await prepare("did:privy:prepare-two");

    expectRefused(refused, 1);
    expect(pins).toBe(pinnedSoFar);
  }, 60_000);

  it("keeps a refused sealed prepare out of every cache", async () => {
    const refused = await prepare("did:privy:prepare-sealed", { sealed: "true" });

    expect(refused.statusCode).toBe(429);
    expect(refused.headers["cache-control"]).toBe("no-store");
  }, 30_000);

  it("takes one generation for the whole world and refuses the next, drawing nothing", async () => {
    const user = "did:privy:draw-one";
    const first = await generate(user, "First of the day");
    expect(first.statusCode).toBe(200);
    // Their own allowance is two, so a refusal below can only be the ceiling for everyone.
    expect(first.json().quota).toEqual({ used: 1, limit: 2, resetsAt: expect.any(Number) });
    expect((await limits()).generations).toEqual({ used: 1, max: 1 });

    const drawnSoFar = stubs.createImage.mock.calls.length;
    const refused = await generate(user, "One too many");

    expectRefused(refused, 1);
    expect(stubs.createImage.mock.calls.length).toBe(drawnSoFar);

    // The ceiling is not this creator's fault, so their own allowance was handed back: with it
    // eaten, this third try would have been refused as "quota" rather than as the global limit.
    const again = await generate(user, "Still theirs to spend");
    expect(again.json().error).toBe("global-limit");
  }, 90_000);

  it("takes one edit for the whole world and refuses the next, sending nothing", async () => {
    const user = "did:privy:edit-one";
    const first = await edit(user, "brightened the sky");
    expect(first.statusCode).toBe(200);
    expect(first.json().quota).toEqual({ used: 1, limit: 2, resetsAt: expect.any(Number) });
    expect((await limits()).edits).toEqual({ used: 1, max: 1 });

    const pinnedSoFar = pins;
    const sentSoFar = stubs.send.mock.calls.length;
    const refused = await edit(user, "one too many");

    expectRefused(refused, 1);
    expect(pins).toBe(pinnedSoFar);
    expect(stubs.send.mock.calls.length).toBe(sentSoFar);

    const again = await edit(user, "still theirs to spend");
    expect(again.json().error).toBe("global-limit");
  }, 90_000);

  it("refuses all three routes in one shape, because one gate writes the refusal for all of them", async () => {
    const refusals = [
      await prepare("did:privy:one-gate-prepare"),
      await generate("did:privy:one-gate-draw", "One gate"),
      await edit("did:privy:one-gate-edit", "one gate"),
    ];

    for (const refusal of refusals) {
      expect(refusal.statusCode).toBe(429);
    }
    // The same body word for word on all three, which is what the shared gate buys: the block used
    // to be copied into each route, and one copy had already drifted from the other two.
    const bodies = refusals.map((refusal) => refusal.json());
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);

    const seconds = refusals.map((refusal) => Number(refusal.headers["retry-after"]));
    expect(Math.max(...seconds) - Math.min(...seconds)).toBeLessThanOrEqual(1);
  }, 60_000);

  it("reports every count and ceiling on /health, and nothing about any caller", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    const body = response.json();

    expect(body.limits).toEqual({
      prepares: { used: 1, max: 1 },
      generations: { used: 1, max: 1 },
      edits: { used: 1, max: 1 },
    });
    expect(JSON.stringify(body)).not.toContain("did:privy:");
  });
});
