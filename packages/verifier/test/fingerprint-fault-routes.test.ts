// Covers a fault of this service while /edit or /generate fingerprints a picture: the blockhash
// worker stops, fingerprint.ts raises FingerprintFault, and both routes answer 503 service-fault
// with the sentence /verify uses, never 415 blaming the file or 502 blaming the model. /edit pins
// and sends nothing, so the day's slot comes back; /generate had the drawing made and paid for, so
// both of its slots stay spent. The worker is replaced by a stand-in that hashes on this thread
// with the same library, or stops with code 1 when told to, as in test/service-fault.test.ts.
// Does NOT cover /prepare or /unseal, a worker past its time limit, a decoder out of memory, a real
// drawing, a real pin, a real chain read or a real send.

import { SignJWT, generateKeyPair } from "jose";
import { getAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { makeImage } from "./helpers.js";

const SETTINGS = vi.hoisted(() => {
  const settings = {
    appId: "moolamtestapp0000184",
    signerId: "moolamtesteditsigner84",
    policyId: "moolamtesteditpolicy84",
  };
  process.env.PRIVY_APP_ID = settings.appId;
  process.env.PINATA_JWT = "test-token-not-a-real-pinata-jwt";
  process.env.PINATA_GATEWAY_URL = "https://moolam-test.mypinata.cloud/ipfs/";
  process.env.PRIVY_EDIT_SIGNER_ID = settings.signerId;
  process.env.PRIVY_EDIT_POLICY_ID = settings.policyId;
  process.env.GENERATE_PER_DAY = "5";
  process.env.EDITS_PER_DAY = "20";
  process.env.GLOBAL_GENERATIONS_PER_DAY = "50";
  process.env.GLOBAL_EDITS_PER_DAY = "50";
  process.env.EXPECT_ROUTES = "";
  process.env.X402_ENABLED = "false";
  return settings;
});

const worker = vi.hoisted(() => ({ dies: false }));

const stubs = vi.hoisted(() => ({
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

vi.mock("node:worker_threads", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:worker_threads")>();
  const { EventEmitter } = await import("node:events");
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const imghash = require("imghash") as { hash: (input: Buffer, bits: number, format: "hex") => Promise<string> };

  class StandInWorker extends EventEmitter {
    postMessage(job: { bytes: Uint8Array; bits: number }): void {
      if (worker.dies) {
        setImmediate(() => this.emit("exit", 1));
        return;
      }
      imghash.hash(Buffer.from(job.bytes), job.bits, "hex").then(
        (hex) => this.emit("message", { hex }),
        (error: unknown) => this.emit("message", { error: error instanceof Error ? error.message : String(error) }),
      );
    }
    ref(): void {}
    unref(): void {}
    async terminate(): Promise<number> {
      return 0;
    }
  }
  return { ...real, Worker: StandInWorker };
});

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
const { SERVICE_FAULT_REASON } = await import("../src/routes/shared.js");

const UPLOAD_URL = "https://uploads.pinata.cloud/v3/files";
const PARENT = `0x${"ce".repeat(32)}` as Hex;
const OWNER = getAddress("0x85a88ca81ff5f681d96ab86fa60ccb8452a139a6");
const FAULT = { error: "service-fault", reason: SERVICE_FAULT_REASON };

let pins = 0;
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

async function edit(user: string) {
  const boundary = "----moolamfault";
  const fields = { title: "Harbour, edited", parentId: PARENT, note: "brighter" };
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="picture.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
    picture,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return await app.inject({
    method: "POST",
    url: "/edit",
    payload: Buffer.concat(parts),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${await token(user)}` },
    remoteAddress: "203.0.113.91",
  });
}

async function generate(user: string, sealed = false) {
  return await app.inject({
    method: "POST",
    url: "/generate",
    payload: {
      prompt: "a lighthouse in a monsoon storm, painted in thick oils",
      title: "Lighthouse",
      creator: OWNER,
      deadline: Math.floor(Date.now() / 1000) + 1800,
      sealed,
    },
    headers: { authorization: `Bearer ${await token(user)}` },
    remoteAddress: "203.0.113.92",
  });
}

async function used(action: "generations" | "edits"): Promise<number> {
  const response = await app.inject({ method: "GET", url: "/health" });
  return (response.json().limits as Record<string, { used: number }>)[action]?.used as number;
}

describe("a fingerprint fault on the routes that register a picture", () => {
  beforeAll(async () => {
    const pair = await generateKeyPair("ES256", { extractable: true });
    signing = pair.privateKey;
    verifying = pair.publicKey;
    picture = await makeImage(84);
    const agent = privateKeyToAccount(generatePrivateKey());

    stubs.passportExists.mockImplementation(async (_chain: unknown, _registry: Hex, id: Hex) => id === PARENT);
    stubs.parentOwner.mockResolvedValue(OWNER);
    stubs.delegatedWallets.mockResolvedValue([{ id: "privy-wallet-1", address: OWNER }]);
    stubs.walletSigners.mockResolvedValue([{ signerId: SETTINGS.signerId, policyIds: [SETTINGS.policyId] }]);
    stubs.estimateEditGas.mockResolvedValue(420_000n);
    stubs.embeddedWallets.mockResolvedValue([OWNER]);
    stubs.createImage.mockImplementation(async () => ({ bytes: picture, model: "gpt-image-1-mini", promptUsed: "" }));
    stubs.generatorWallet.mockResolvedValue({ id: "moolam-test-generator", address: agent.address });
    stubs.signAsGenerator.mockResolvedValue(`0x${"11".repeat(65)}`);

    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== UPLOAD_URL) {
        return await realFetch(input, init);
      }
      pins += 1;
      const bytes = Buffer.from(await ((init?.body as FormData).get("file") as File).arrayBuffer());
      return new Response(JSON.stringify({ data: { cid: contentIdOf(bytes), size: bytes.length, network: "public" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    app = await buildServer({
      source: { load: async () => [] },
      logger: false,
      generate: { keys: verifying },
      edit: { keys: verifying },
    });
    await app.ready();
  }, 60_000);

  beforeEach(() => {
    worker.dies = false;
    pins = 0;
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await app.close();
  });

  it("answers /edit with 503 service-fault, pins and sends nothing, and hands the day's slot back", async () => {
    const before = await used("edits");
    worker.dies = true;

    const refused = await edit("did:privy:fault-edit");

    expect(refused.statusCode).toBe(503);
    expect(refused.json()).toEqual(FAULT);
    expect(pins).toBe(0);
    expect(stubs.send).not.toHaveBeenCalled();
    expect(await used("edits")).toBe(before);
  }, 60_000);

  it("answers /generate with 503 service-fault, public or sealed, and keeps both slots spent", async () => {
    const user = "did:privy:fault-generate";
    const before = await used("generations");
    worker.dies = true;

    for (const sealed of [false, true]) {
      const refused = await generate(user, sealed);
      expect(refused.statusCode, String(sealed)).toBe(503);
      expect(refused.json(), String(sealed)).toEqual(FAULT);
    }
    expect(pins).toBe(0);
    expect(await used("generations")).toBe(before + 2);

    worker.dies = false;
    const next = await generate(user);
    expect(next.statusCode).toBe(200);
    expect(next.json().quota.used).toBe(3);
  }, 120_000);
});
