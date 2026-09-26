// Covers three refusals and one slot rule from review pass 6, on the routes that register a
// picture, with Pinata answered by a stub at the fetch layer and the image model, the chain and
// Privy stubbed. V39: /edit and /generate refuse a picture whose fingerprint does not survive its
// own thumbnail with 422 fingerprint-unstable before any pin, as /prepare does, and /generate keeps
// the day's slots spent because the drawing was paid for, while a real photo passes both. V40: /edit
// refuses a signed file past the upload cap with 413 before the duplicate check and any pin. V41: a
// public pin that failed after the file left this process (a 5xx on both attempts, an abort after
// the body went out, an answer naming another content id or network) keeps the day's slot spent on
// /prepare and /edit, and only Pinata's own 4xx hands it back.
// Does NOT cover a real pin, a real drawing, a real chain read or a real send, the per-user limits,
// or /unseal, which keeps its own pin accounting.

import { readFileSync } from "node:fs";
import path from "node:path";
import { SignJWT, generateKeyPair } from "jose";
import { getAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { makeImage } from "./helpers.js";
import { grownWithTables, skyOverHorizon } from "./jpegParts.js";

const SETTINGS = vi.hoisted(() => {
  const settings = {
    appId: "moolamtestapp0000183",
    signerId: "moolamtesteditsigner83",
    policyId: "moolamtesteditpolicy83",
  };
  process.env.PRIVY_APP_ID = settings.appId;
  process.env.PINATA_JWT = "test-token-not-a-real-pinata-jwt";
  process.env.PINATA_GATEWAY_URL = "https://moolam-test.mypinata.cloud/ipfs/";
  process.env.PRIVY_EDIT_SIGNER_ID = settings.signerId;
  process.env.PRIVY_EDIT_POLICY_ID = settings.policyId;
  process.env.GENERATE_PER_DAY = "5";
  process.env.EDITS_PER_DAY = "20";
  process.env.GLOBAL_PREPARES_PER_DAY = "50";
  process.env.GLOBAL_GENERATIONS_PER_DAY = "50";
  process.env.GLOBAL_EDITS_PER_DAY = "50";
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

vi.mock("../src/generate/privy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/generate/privy.js")>()),
  privy: () => ({}),
  ownerContext: () => ({}),
}));

const { buildServer } = await import("../src/server.js");
const { contentIdOf } = await import("../src/ipfs/pinata.js");
const { MAX_UPLOAD_BYTES, PACKAGE_ROOT } = await import("../src/env.js");
const { FINGERPRINT_UNSTABLE_REASON, SIGNED_FILE_TOO_LARGE_REASON } = await import("../src/prepare.js");
const { PHASH_MATCH_THRESHOLD } = await import("../src/fingerprint.js");

const UPLOAD_URL = "https://uploads.pinata.cloud/v3/files";
const PARENT = `0x${"cd".repeat(32)}` as Hex;
const HASH = `0x${"44".repeat(32)}` as Hex;
const OWNER = getAddress("0x85a88ca81ff5f681d96ab86fa60ccb8452a139a6");
const emptySource = { load: async () => [] };

/**
 * How Pinata answers every public pin: it takes the file, it fails with a 502 on both attempts, it
 * holds the connection until the client aborts after the body went out, it answers 200 for a file
 * on another network, or it refuses the token with a 401.
 */
type Pinata = "takes" | "502" | "abort" | "unconfirmed" | "401";
let pinata: Pinata = "takes";
let pins = 0;

let signing: CryptoKey;
let verifying: CryptoKey;
let app: FastifyInstance;
let picture: Buffer;
let photo: Buffer;
let sky: Buffer;

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

function multipart(fields: Record<string, string>, content: Buffer): { payload: Buffer; headers: Record<string, string> } {
  const boundary = "----moolamintake";
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="picture.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return { payload: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

async function prepare(user: string, content: Buffer = picture) {
  const { payload, headers } = multipart({ title: "Harbour", kind: "human" }, content);
  return await app.inject({
    method: "POST",
    url: "/prepare",
    payload,
    headers: { ...headers, authorization: `Bearer ${await token(user)}` },
    remoteAddress: "203.0.113.80",
  });
}

async function edit(user: string, content: Buffer = picture) {
  const { payload, headers } = multipart({ title: "Harbour, edited", parentId: PARENT, note: "brighter" }, content);
  return await app.inject({
    method: "POST",
    url: "/edit",
    payload,
    headers: { ...headers, authorization: `Bearer ${await token(user)}` },
    remoteAddress: "203.0.113.81",
  });
}

async function generate(user: string, sealed = false) {
  return await app.inject({
    method: "POST",
    url: "/generate",
    payload: {
      prompt: "a smooth sunset gradient over a flat sea, minimalist",
      title: "Flat sea",
      creator: OWNER,
      deadline: Math.floor(Date.now() / 1000) + 1800,
      sealed,
    },
    headers: { authorization: `Bearer ${await token(user)}` },
    remoteAddress: "203.0.113.82",
  });
}

async function used(action: "prepares" | "generations" | "edits"): Promise<number> {
  const response = await app.inject({ method: "GET", url: "/health" });
  return (response.json().limits as Record<string, { used: number }>)[action]?.used as number;
}

describe("review pass 6: the routes that register a picture", () => {
  beforeAll(async () => {
    const pair = await generateKeyPair("ES256", { extractable: true });
    signing = pair.privateKey;
    verifying = pair.publicKey;
    picture = await makeImage(83);
    photo = readFileSync(path.join(PACKAGE_ROOT, "test", "fixtures", "pinned-hero.jpg"));
    sky = await skyOverHorizon(3, 1024, 1024);
    const agent = privateKeyToAccount(generatePrivateKey());

    stubs.ensureSigner.mockResolvedValue(undefined);
    stubs.parentOwner.mockResolvedValue(OWNER);
    stubs.delegatedWallets.mockResolvedValue([{ id: "privy-wallet-1", address: OWNER }]);
    stubs.walletSigners.mockResolvedValue([{ signerId: SETTINGS.signerId, policyIds: [SETTINGS.policyId] }]);
    stubs.send.mockResolvedValue({ hash: HASH, sponsored: true, transactionId: "privy-tx-1" });
    stubs.receipt.mockResolvedValue({ status: "reverted" });
    stubs.estimateEditGas.mockResolvedValue(420_000n);
    stubs.embeddedWallets.mockResolvedValue([OWNER]);
    stubs.generatorWallet.mockResolvedValue({ id: "moolam-test-generator", address: agent.address });
    stubs.signAsGenerator.mockResolvedValue(`0x${"11".repeat(65)}`);

    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== UPLOAD_URL) {
        return await realFetch(input, init);
      }
      pins += 1;
      const file = (init?.body as FormData).get("file") as File;
      const bytes = Buffer.from(await file.arrayBuffer());
      if (pinata === "502") {
        return new Response("bad gateway", { status: 502 });
      }
      if (pinata === "abort") {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }
      if (pinata === "401") {
        return new Response("invalid token", { status: 401 });
      }
      const network = pinata === "unconfirmed" ? "private" : "public";
      return new Response(JSON.stringify({ data: { cid: contentIdOf(bytes), size: bytes.length, network } }), {
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
  }, 60_000);

  beforeEach(() => {
    pinata = "takes";
    pins = 0;
    stubs.passportExists.mockReset().mockImplementation(async (_chain: unknown, _registry: Hex, id: Hex) => id === PARENT);
    stubs.createImage.mockReset().mockImplementation(async () => ({ bytes: sky, model: "gpt-image-1-mini", promptUsed: "" }));
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await app.close();
  });

  describe("V39: a fingerprint that does not survive its own thumbnail", () => {
    it("is refused by /edit with 422 before any pin or send", async () => {
      const before = await used("edits");

      const refused = await edit("did:privy:v39-edit-sky", sky);

      expect(refused.statusCode).toBe(422);
      const answer = refused.json();
      expect(answer.error).toBe("fingerprint-unstable");
      expect(answer.limit).toBe(PHASH_MATCH_THRESHOLD);
      expect(answer.distance).toBeGreaterThan(PHASH_MATCH_THRESHOLD);
      expect(answer.reason).toBe(FINGERPRINT_UNSTABLE_REASON);
      expect(pins).toBe(0);
      expect(stubs.send).not.toHaveBeenCalled();
      expect(await used("edits")).toBe(before);
    }, 60_000);

    it("is refused by /generate with 422 before any pin, public or sealed, and the day's slots stay spent", async () => {
      const user = "did:privy:v39-generate-sky";
      const before = await used("generations");

      for (const sealed of [false, true]) {
        const refused = await generate(user, sealed);
        expect(refused.statusCode, String(sealed)).toBe(422);
        expect(refused.json().error, String(sealed)).toBe("fingerprint-unstable");
        expect(refused.json().reason, String(sealed)).toBe(FINGERPRINT_UNSTABLE_REASON);
      }
      expect(pins).toBe(0);
      expect(await used("generations")).toBe(before + 2);

      stubs.createImage.mockImplementation(async () => ({ bytes: photo, model: "gpt-image-1-mini", promptUsed: "" }));
      const next = await generate(user);
      expect(next.statusCode).toBe(200);
      expect(next.json().quota.used).toBe(3);
    }, 120_000);

    it("lets a real photo through /edit and /generate", async () => {
      stubs.createImage.mockImplementation(async () => ({ bytes: photo, model: "gpt-image-1-mini", promptUsed: "" }));

      const drawn = await generate("did:privy:v39-generate-photo");
      expect(drawn.statusCode).toBe(200);

      // The stubbed receipt says reverted, so a real photo reaching the send is the proof here.
      const sendsBefore = stubs.send.mock.calls.length;
      const edited = await edit("did:privy:v39-edit-photo", photo);
      expect(edited.json().error).toBe("send-failed");
      expect(stubs.send.mock.calls.length).toBe(sendsBefore + 1);
    }, 60_000);
  });

  it("V40: /edit refuses an upload under the cap whose signed file crosses it, before the duplicate check and any pin", async () => {
    const nearCap = grownWithTables(picture, MAX_UPLOAD_BYTES - 20_000);
    expect(nearCap.length).toBeLessThan(MAX_UPLOAD_BYTES);
    expect(nearCap.length).toBeGreaterThan(MAX_UPLOAD_BYTES - 30_000);
    const before = await used("edits");
    const checksBefore = stubs.passportExists.mock.calls.length;

    const refused = await edit("did:privy:v40-edit", nearCap);

    expect(refused.statusCode).toBe(413);
    expect(refused.json()).toEqual({
      error: "signed-file-too-large",
      limit: MAX_UPLOAD_BYTES,
      reason: SIGNED_FILE_TOO_LARGE_REASON,
    });
    // One read for the parent and none for the child.
    expect(stubs.passportExists.mock.calls.length - checksBefore).toBe(1);
    expect(pins).toBe(0);
    expect(await used("edits")).toBe(before);
  }, 120_000);

  describe("V41: a failed public pin that may have stored the file", () => {
    const cases: [Pinata, boolean][] = [
      ["502", true],
      ["abort", true],
      ["unconfirmed", true],
      ["401", false],
    ];

    it.each(cases)("keeps the /prepare slot spent after a %s: %s", async (answer, kept) => {
      const before = await used("prepares");
      pinata = answer;

      const refused = await prepare(`did:privy:v41-prepare-${answer}`);

      expect(refused.statusCode).toBe(502);
      expect(refused.json()).toEqual({ error: "pin-failed" });
      expect(await used("prepares")).toBe(kept ? before + 1 : before);
    }, 60_000);

    it.each(cases)("keeps the /edit slot spent after a %s: %s", async (answer, kept) => {
      const before = await used("edits");
      pinata = answer;

      const refused = await edit(`did:privy:v41-edit-${answer}`);

      expect(refused.statusCode).toBe(502);
      expect(refused.json()).toEqual({ error: "pin-failed" });
      expect(await used("edits")).toBe(kept ? before + 1 : before);
    }, 60_000);
  });
});
