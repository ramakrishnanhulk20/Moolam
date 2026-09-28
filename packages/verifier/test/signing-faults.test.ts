// Covers review pass 9 on the signing path. V88: a read-back of the freshly signed file that comes
// back unreadable, which is also what readManifest answers once READ_MANIFEST_TIMEOUT_MS passes, is
// this service's fault, so /prepare answers 503 service-fault, public or sealed, and hands back no
// unsigned file, while a file the signer truly refuses still falls back to an unsigned passport.
// V91: a signing worker that fails after the model drew and billed a picture answers /generate 502
// sign-failed, not model-failed, and keeps both slots spent. The /prepare and /generate logs name a
// read-back fault as one, not as a fingerprinting failure.
// The read-back answer is stubbed as readManifest's own "unreadable" summary rather than waiting out
// the real five second limit, and the signer failures are thrown by a stubbed embedManifest. Does
// NOT cover a real slow C2PA read, a real signing worker crash, a real drawing or a real pin.

import { SignJWT, generateKeyPair } from "jose";
import { getAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { makeImage } from "./helpers.js";

const SETTINGS = vi.hoisted(() => {
  const settings = { appId: "moolamtestapp0000186" };
  process.env.PRIVY_APP_ID = settings.appId;
  process.env.PINATA_JWT = "test-token-not-a-real-pinata-jwt";
  process.env.PINATA_GATEWAY_URL = "https://moolam-test.mypinata.cloud/ipfs/";
  process.env.GENERATE_PER_DAY = "5";
  process.env.GLOBAL_GENERATIONS_PER_DAY = "50";
  process.env.GLOBAL_PREPARES_PER_DAY = "50";
  process.env.EXPECT_ROUTES = "";
  process.env.X402_ENABLED = "false";
  return settings;
});

const stubs = vi.hoisted(() => ({
  readBackUnreadable: false,
  embedManifest: vi.fn(),
  passportExists: vi.fn(),
  createImage: vi.fn(),
  embeddedWallets: vi.fn(),
  generatorWallet: vi.fn(),
  signAsGenerator: vi.fn(),
}));

vi.mock("../src/c2pa.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/c2pa.js")>();
  stubs.embedManifest.mockImplementation(real.embedManifest);
  return {
    ...real,
    embedManifest: stubs.embedManifest,
    readManifest: async (bytes: Buffer) => (stubs.readBackUnreadable ? real.manifestUnreadable() : await real.readManifest(bytes)),
  };
});

vi.mock("../src/edit/registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/edit/registry.js")>()),
  passportExists: stubs.passportExists,
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
const { SignerRefusedFile, SignerUnavailable } = await import("../src/c2pa.js");
const { FingerprintFault } = await import("../src/fingerprint.js");
const { prepareOrFallback, prepareSealed } = await import("../src/prepare.js");

const UPLOAD_URL = "https://uploads.pinata.cloud/v3/files";
const OWNER = getAddress("0x85a88ca81ff5f681d96ab86fa60ccb8452a139a6");
const FAULT = { error: "service-fault", reason: SERVICE_FAULT_REASON };
const SETTINGS_FOR_PREPARE = { title: "Harbour", claimGenerator: "moolam-studio/0.1.0", action: "c2pa.opened" as const };

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

async function prepareUpload(user: string, sealed: boolean) {
  const boundary = "----moolamreadback";
  const fields = { title: "Harbour at first light", kind: "human", sealed: String(sealed) };
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
    url: "/prepare",
    payload: Buffer.concat(parts),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${await token(user)}` },
    remoteAddress: "203.0.113.95",
  });
}

async function generate(user: string) {
  return await app.inject({
    method: "POST",
    url: "/generate",
    payload: {
      prompt: "a lighthouse in a monsoon storm, painted in thick oils",
      title: "Lighthouse",
      creator: OWNER,
      deadline: Math.floor(Date.now() / 1000) + 1800,
    },
    headers: { authorization: `Bearer ${await token(user)}` },
    remoteAddress: "203.0.113.96",
  });
}

async function used(action: "generations" | "prepares"): Promise<number> {
  const response = await app.inject({ method: "GET", url: "/health" });
  return (response.json().limits as Record<string, { used: number }>)[action]?.used as number;
}

describe("faults on the signing path", () => {
  beforeAll(async () => {
    const pair = await generateKeyPair("ES256", { extractable: true });
    signing = pair.privateKey;
    verifying = pair.publicKey;
    picture = await makeImage(186);
    const agent = privateKeyToAccount(generatePrivateKey());

    stubs.passportExists.mockResolvedValue(false);
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
      prepare: { keys: verifying },
    });
    await app.ready();
  }, 60_000);

  beforeEach(() => {
    stubs.readBackUnreadable = false;
    pins = 0;
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await app.close();
  });

  it("V88: answers /prepare 503 service-fault, public or sealed, when the read-back is unreadable, and pins nothing", async () => {
    const before = await used("prepares");
    stubs.readBackUnreadable = true;

    for (const sealed of [false, true]) {
      const refused = await prepareUpload("did:privy:readback-prepare", sealed);
      expect(refused.statusCode, String(sealed)).toBe(503);
      expect(refused.json(), String(sealed)).toEqual(FAULT);
    }
    expect(pins).toBe(0);
    expect(await used("prepares")).toBe(before);

    stubs.readBackUnreadable = true;
    await expect(prepareOrFallback(picture, SETTINGS_FOR_PREPARE)).rejects.toBeInstanceOf(FingerprintFault);
    await expect(prepareSealed(picture, SETTINGS_FOR_PREPARE)).rejects.toBeInstanceOf(FingerprintFault);
  }, 120_000);

  it("logs an unreadable read-back on /prepare as a signing read-back fault, not as failed fingerprinting", async () => {
    const logged = vi.spyOn(app.log, "error");
    stubs.readBackUnreadable = true;
    try {
      expect((await prepareUpload("did:privy:readback-log", false)).statusCode).toBe(503);
      const lines = logged.mock.calls.map((call) => call[1]);
      expect(lines).toContain("rejected: /prepare signing read-back fault");
      expect(lines).not.toContain("rejected: /prepare the service failed fingerprinting");
    } finally {
      logged.mockRestore();
    }
  }, 120_000);

  it("logs an unreadable read-back on /generate as a signing read-back fault, and answers 503 service-fault", async () => {
    const logged = vi.spyOn(app.log, "error");
    stubs.readBackUnreadable = true;
    try {
      const refused = await generate("did:privy:readback-generate-log");
      expect(refused.statusCode).toBe(503);
      expect(refused.json()).toEqual(FAULT);
      const lines = logged.mock.calls.map((call) => call[1]);
      expect(lines).toContain("rejected: /generate signing read-back fault");
      expect(lines).not.toContain("rejected: /generate the service failed fingerprinting");
    } finally {
      logged.mockRestore();
    }
  }, 120_000);

  it("V88: still falls back to an unsigned passport for a file the signer truly refuses", async () => {
    stubs.embedManifest.mockRejectedValueOnce(new SignerRefusedFile("the signer would not take this container"));
    const fallback = await prepareOrFallback(picture, SETTINGS_FOR_PREPARE);
    expect(fallback.embedded).toBe(false);
    expect(fallback.manifestHash).toBe(`0x${"00".repeat(32)}`);

    stubs.embedManifest.mockRejectedValueOnce(new SignerRefusedFile("the signer would not take this container"));
    const response = await prepareUpload("did:privy:readback-refused", false);
    expect(response.statusCode).toBe(200);
    expect(response.json().manifest.embedded).toBe(false);
  }, 120_000);

  it("V91: answers /generate 502 sign-failed when the signing worker fails after the drawing, and keeps both slots spent", async () => {
    const user = "did:privy:sign-failed-generate";
    const before = await used("generations");
    stubs.embedManifest.mockRejectedValueOnce(new SignerUnavailable("the signing worker stopped with code 1"));

    const refused = await generate(user);

    expect(refused.statusCode).toBe(502);
    expect(refused.json()).toEqual({ error: "sign-failed" });
    expect(pins).toBe(0);
    expect(await used("generations")).toBe(before + 1);

    const next = await generate(user);
    expect(next.statusCode).toBe(200);
    expect(next.json().quota.used).toBe(2);
  }, 120_000);
});
