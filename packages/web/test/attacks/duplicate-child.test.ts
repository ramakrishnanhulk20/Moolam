// Attack 7 of the second attack pass: the same edited picture posted twice on the unsigned
// fallback path, where the bytes are deterministic and a second pin would be money spent on a
// passport that can never be registered.
// The C2PA signer is made to refuse this one file, so the route runs its real fallback branch.
// Privy, the chain reads and Pinata are stubbed, the way packages/verifier/test/edit.test.ts
// stubs them: the receipt carries the registry's full PassportRegistered event and readPassport
// answers from the stub, so no request here leaves the machine (test/network-guard.ts fails any
// that tries).
// Does NOT cover the signed path (a fresh manifest changes the bytes, so two uploads of one
// picture get two ids), Privy actually signing, or the registry refusing the duplicate itself.
// The registry's own refusal is proven on chain by packages/agents/scripts/attack-pass-2.ts.

import { SignJWT, generateKeyPair } from "jose";
import { getAddress, type Hex } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

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
  process.env.EDITS_PER_DAY = "6";
  return settings;
});

const stubs = vi.hoisted(() => ({
  delegatedWallets: vi.fn(),
  walletSigners: vi.fn(),
  passportExists: vi.fn(),
  parentOwner: vi.fn(),
  estimateEditGas: vi.fn(),
  send: vi.fn(),
  receipt: vi.fn(),
  readPassport: vi.fn(),
}));

vi.mock("@moolam/verifier/src/edit/signers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@moolam/verifier/src/edit/signers.js")>()),
  delegatedWallets: stubs.delegatedWallets,
  walletSigners: stubs.walletSigners,
}));

vi.mock("@moolam/verifier/src/edit/registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@moolam/verifier/src/edit/registry.js")>()),
  passportExists: stubs.passportExists,
  parentOwner: stubs.parentOwner,
  estimateEditGas: stubs.estimateEditGas,
}));

vi.mock("@moolam/verifier/src/edit/send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@moolam/verifier/src/edit/send.js")>()),
  sendFromWallet: stubs.send,
  awaitReceipt: stubs.receipt,
}));

vi.mock("@moolam/verifier/src/unseal.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@moolam/verifier/src/unseal.js")>()),
  readPassport: stubs.readPassport,
}));

vi.mock("@moolam/verifier/src/generate/privy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@moolam/verifier/src/generate/privy.js")>()),
  privy: () => ({}),
  ownerContext: () => ({}),
}));

// The one change that puts the route on its unsigned path: this host can sign, and it will not
// take this particular file, which is the case prepareOrFallback was written for.
vi.mock("@moolam/verifier/src/c2pa.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("@moolam/verifier/src/c2pa.js")>();
  return {
    ...real,
    embedManifest: () => {
      throw new real.SignerRefusedFile("this signer would not take the file");
    },
  };
});

const { buildServer } = await import("@moolam/verifier/src/server.js");
const { makeImage, registeredEventLog } = await import("@moolam/verifier/test/helpers.js");
const { contentIdOf } = await import("@moolam/verifier/src/ipfs/pinata.js");
const { env } = await import("@moolam/verifier/src/env.js");

const UPLOAD_URL = "https://uploads.pinata.cloud/v3/files";
const OWNER = getAddress("0x85a88ca81ff5f681d96ab86fa60ccb8452a139a6");
const PARENT = `0x${"ab".repeat(32)}` as Hex;
const HASH = `0x${"11".repeat(32)}` as Hex;
const USER = "did:privy:attack-pass-2-duplicate";

/**
 * The receipt of a send whose appendEdit ran. The route believes an edit only when the registry's
 * own event for the child it sent is in the logs, decoded in full: the id, the creator and the
 * parent must all match (V95), so the event is built from the calldata the way the verifier's own
 * tests build it.
 */
async function landedReceipt(): Promise<{ status: "success"; logs: { address: Hex; topics: Hex[]; data: Hex }[] }> {
  const sent = stubs.send.mock.lastCall?.[2] as { data: Hex };
  return { status: "success", logs: [registeredEventLog(env.MOOLAM_REGISTRY_ADDRESS as Hex, sent.data)] };
}

let signing: CryptoKey;
let verifying: CryptoKey;
let app: FastifyInstance;
let picture: Buffer;
/** Every id the registry is holding, so the second post meets the state the first one left. */
let registered: Set<string>;
/** How many files this request pinned, so a refusal before any pin can be proven. */
let pins = 0;

async function token(): Promise<string> {
  return await new SignJWT({})
    .setProtectedHeader({ alg: "ES256" })
    .setIssuer("privy.io")
    .setAudience(SETTINGS.appId)
    .setSubject(USER)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(signing);
}

async function post(bytes: Buffer) {
  const boundary = "----moolamattackpass2";
  const fields = { title: "Monsoon nets, brightened", parentId: PARENT, note: "same edit" };
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="edited.jpg"\r\n` +
        `Content-Type: image/jpeg\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );

  return await app.inject({
    method: "POST",
    url: "/edit",
    payload: Buffer.concat(parts),
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      authorization: `Bearer ${await token()}`,
    },
    remoteAddress: "203.0.113.41",
  });
}

describe("the same fallback bytes posted twice", () => {
  beforeAll(async () => {
    const pair = await generateKeyPair("ES256", { extractable: true });
    signing = pair.privateKey;
    verifying = pair.publicKey;
    picture = await makeImage(21);

    // Anything but the Pinata upload goes on to the network guard, which fails the test.
    const guarded = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== UPLOAD_URL) {
        return await guarded(input, init);
      }
      pins += 1;
      const file = (init?.body as FormData).get("file") as File;
      const bytes = Buffer.from(await file.arrayBuffer());
      // The route believes a pin only when it is public and names the content id of the bytes sent.
      return new Response(JSON.stringify({ data: { cid: contentIdOf(bytes), size: bytes.length, network: "public" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    app = await buildServer({ source: { load: async () => [] }, logger: false, edit: { keys: verifying } });
    app.verifier.runPrepare = (async (task: () => Promise<unknown>) => await task()) as typeof app.verifier.runPrepare;
    await app.ready();
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await app.close();
  });

  beforeEach(() => {
    pins = 0;
    registered = new Set([PARENT]);
    stubs.passportExists.mockReset().mockImplementation(async (_chain, _registry, id: Hex) => registered.has(id));
    stubs.delegatedWallets.mockReset().mockResolvedValue([{ id: "privy-wallet-1", address: OWNER }]);
    stubs.walletSigners
      .mockReset()
      .mockResolvedValue([{ signerId: SETTINGS.signerId, policyIds: [SETTINGS.policyId] }]);
    stubs.parentOwner.mockReset().mockResolvedValue(OWNER);
    stubs.estimateEditGas.mockReset().mockResolvedValue(420_000n);
    stubs.send.mockReset().mockResolvedValue({ hash: HASH, sponsored: true, transactionId: "privy-tx-1" });
    stubs.receipt.mockReset().mockImplementation(landedReceipt);
    // Only read when the receipt shows no child. A chain that holds nothing for it keeps a missing
    // event a failure here, instead of a quiet read of the live registry.
    stubs.readPassport.mockReset().mockResolvedValue(undefined);
  });

  it("answers 409 already-registered on the second, before a single byte is pinned", async () => {
    const first = await post(picture);
    expect(first.statusCode).toBe(200);
    expect(first.json().manifest).toEqual({ embedded: false, reason: expect.any(String) });
    expect(pins).toBeGreaterThan(0);

    const childId = first.json().child.exactHash as Hex;
    registered.add(childId);
    const sendsAfterFirst = stubs.send.mock.calls.length;
    pins = 0;

    const second = await post(picture);

    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: "already-registered", passportId: childId });
    expect(pins).toBe(0);
    expect(stubs.send.mock.calls.length).toBe(sendsAfterFirst);
  }, 60_000);

  it("is a duplicate at all because the unsigned bytes are the same bytes every time", async () => {
    const first = await post(picture);
    const second = await post(picture);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().child.exactHash).toBe(first.json().child.exactHash);
  }, 60_000);
});
