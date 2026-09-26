// Covers when a spending route keeps the day's slot for everyone and when it hands it back, on all
// three routes, with Pinata answered by a stub that can be told to refuse and the image model, the
// chain and Privy stubbed. The rule under test: the slot goes back on every exit that spent
// nothing, and stays taken the moment a pin has landed or a picture has been drawn. Before this,
// /prepare never handed its slot back at all, so a bad hour at Pinata closed the studio until
// midnight UTC with nothing to show for it, and /edit handed its slot back after four pins had
// already been paid for.
// It also covers the three public pins going to Pinata at once instead of one after the next,
// proved by the order of what the stub saw rather than by a clock.
// The ceilings here are five per action, so a give-back is visible on /health rather than being
// hidden behind a refusal. Midnight, the counter itself and the refusal shape are
// test/globalDay.test.ts and test/global-limits.test.ts.
// Does NOT cover a real pin, a real drawing, a real chain read or a real send.

import { SignJWT, generateKeyPair } from "jose";
import { getAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { makeImage } from "./helpers.js";

// env.ts validates once at import, so everything the routes read has to be set before any module in
// this file loads. vi.hoisted runs before the imports above. The Pinata token is a fake: every call
// to Pinata is answered by the stub below.
const SETTINGS = vi.hoisted(() => {
  const settings = {
    appId: "moolamtestapp0000007",
    signerId: "moolamtesteditsigner07",
    policyId: "moolamtesteditpolicy07",
  };
  process.env.PRIVY_APP_ID = settings.appId;
  process.env.PINATA_JWT = "test-token-not-a-real-pinata-jwt";
  process.env.PINATA_GATEWAY_URL = "https://moolam-test.mypinata.cloud/ipfs/";
  process.env.PRIVY_EDIT_SIGNER_ID = settings.signerId;
  process.env.PRIVY_EDIT_POLICY_ID = settings.policyId;
  process.env.GENERATE_PER_DAY = "5";
  process.env.EDITS_PER_DAY = "5";
  process.env.GLOBAL_PREPARES_PER_DAY = "5";
  process.env.GLOBAL_GENERATIONS_PER_DAY = "5";
  process.env.GLOBAL_EDITS_PER_DAY = "5";
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

// Nothing here calls Privy: every function that would is stubbed above.
vi.mock("../src/generate/privy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/generate/privy.js")>()),
  privy: () => ({}),
  ownerContext: () => ({}),
}));

const { PromptRefused } = await import("../src/generate/imageModel.js");
const { buildServer } = await import("../src/server.js");
const { contentIdOf } = await import("../src/ipfs/pinata.js");

const UPLOAD_URL = "https://uploads.pinata.cloud/v3/files";
const PARENT = `0x${"ef".repeat(32)}` as Hex;
const HASH = `0x${"33".repeat(32)}` as Hex;
const OWNER = getAddress("0x85a88ca81ff5f681d96ab86fa60ccb8452a139a6");
const emptySource = { load: async () => [] };

/**
 * How Pinata answers for the next request: every pin, none of them, or every pin but the last.
 *
 * "all but the last" is a public registration whose picture, thumbnail and manifest landed and
 * whose metadata document did not: money spent, nothing usable, and the case where the day's slot
 * has to stay taken.
 */
type Pinata = "takes everything" | "refuses everything" | "refuses the last";

let pinata: Pinata = "takes everything";
/** Every pin the stub was asked for since the last mark, and whether it started or finished. */
let steps: string[] = [];
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
  const boundary = "----moolamslots";
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="picture.jpg"\r\n` +
        "Content-Type: image/jpeg\r\n\r\n",
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return { payload: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

async function prepare(user: string, title: string) {
  const { payload, headers } = multipart({ title, kind: "human" }, picture);
  return await app.inject({
    method: "POST",
    url: "/prepare",
    payload,
    headers: { ...headers, authorization: `Bearer ${await token(user)}` },
    remoteAddress: "203.0.113.70",
  });
}

async function generate(user: string, title: string) {
  return await app.inject({
    method: "POST",
    url: "/generate",
    payload: {
      prompt: "A lighthouse in a monsoon storm, painted in thick oils",
      title,
      creator: OWNER,
      deadline: Math.floor(Date.now() / 1000) + 1800,
    },
    headers: { authorization: `Bearer ${await token(user)}` },
    remoteAddress: "203.0.113.71",
  });
}

async function edit(user: string, note: string) {
  const { payload, headers } = multipart({ title: "Nets, brightened", parentId: PARENT, note }, picture);
  return await app.inject({
    method: "POST",
    url: "/edit",
    payload,
    headers: { ...headers, authorization: `Bearer ${await token(user)}` },
    remoteAddress: "203.0.113.72",
  });
}

async function used(action: "prepares" | "generations" | "edits"): Promise<number> {
  const response = await app.inject({ method: "GET", url: "/health" });
  return (response.json().limits as Record<string, { used: number }>)[action]?.used as number;
}

describe("the day's slot for everyone, kept or handed back", () => {
  beforeAll(async () => {
    const pair = await generateKeyPair("ES256", { extractable: true });
    signing = pair.privateKey;
    verifying = pair.publicKey;
    agent = privateKeyToAccount(generatePrivateKey());
    picture = await makeImage(47);

    stubs.ensureSigner.mockResolvedValue(undefined);
    stubs.parentOwner.mockResolvedValue(OWNER);
    stubs.delegatedWallets.mockResolvedValue([{ id: "privy-wallet-1", address: OWNER }]);
    stubs.walletSigners.mockResolvedValue([{ signerId: SETTINGS.signerId, policyIds: [SETTINGS.policyId] }]);
    stubs.send.mockResolvedValue({ hash: HASH, sponsored: true, transactionId: "privy-tx-1" });
    stubs.receipt.mockResolvedValue({ status: "success" });
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
      steps.push("start");
      const form = init?.body as FormData;
      const name = String(form.get("name"));
      const file = form.get("file") as File;
      const bytes = Buffer.from(await file.arrayBuffer());
      // A real pin is a network wait. The delay is what lets the order of events below show three
      // uploads in the air at the same time rather than three that merely happened.
      await new Promise((resolve) => setTimeout(resolve, 20));
      steps.push("end");

      // The metadata document is the one pin that has to wait for the other three, so it is the
      // one that can fail with three files already paid for. It is named for the slug alone.
      const isMetadata = name.endsWith(".json") && !name.endsWith("-c2pa.json");
      if (pinata === "refuses everything" || (pinata === "refuses the last" && isMetadata)) {
        // A 4xx rather than a 5xx, because pinFile retries a server error once and this test is
        // about what the route does with the refusal, not about the retry.
        return new Response("this test told Pinata to refuse", { status: 400 });
      }
      return new Response(JSON.stringify({ data: { cid: contentIdOf(bytes), size: bytes.length, network: "public" } }), {
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

  beforeEach(() => {
    pinata = "takes everything";
    steps = [];
    // The parent is registered and nothing else is, which is what a first edit needs.
    stubs.passportExists.mockImplementation(async (_chain: unknown, _registry: Hex, id: Hex) => id === PARENT);
    stubs.estimateEditGas.mockResolvedValue(420_000n);
    stubs.createImage.mockImplementation(async (prompt: string) => ({
      bytes: await makeImage(prompt.length % 40),
      model: "gpt-image-1-mini",
      promptUsed: prompt,
    }));
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await app.close();
  });

  it("gives a prepare slot back when nothing was pinned, and keeps it once a pin has landed", async () => {
    const before = await used("prepares");

    pinata = "refuses everything";
    const nothingPinned = await prepare("did:privy:slot-prepare-a", "Pinata was down");
    expect(nothingPinned.statusCode).toBe(502);
    expect(nothingPinned.json().error).toBe("pin-failed");
    expect(await used("prepares")).toBe(before);

    // The picture, its thumbnail and the manifest landed; the metadata document did not. That is
    // three files of somebody's plan spent, so the slot stays taken.
    pinata = "refuses the last";
    const partlyPinned = await prepare("did:privy:slot-prepare-b", "Only the metadata failed");
    expect(partlyPinned.statusCode).toBe(502);
    expect(await used("prepares")).toBe(before + 1);
  }, 60_000);

  it("gives a prepare slot back when the picture was already registered, before any pin", async () => {
    const before = await used("prepares");
    stubs.passportExists.mockResolvedValue(true);

    const duplicate = await prepare("did:privy:slot-prepare-dup", "Sent twice");

    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error).toBe("already-registered");
    expect(await used("prepares")).toBe(before);
  }, 60_000);

  it("gives a generation slot back when the model refused the prompt, and keeps it once a picture was drawn", async () => {
    const before = await used("generations");

    stubs.createImage.mockRejectedValueOnce(new PromptRefused("the safety system turned this prompt down"));
    const refused = await generate("did:privy:slot-draw-a", "Never drawn");
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toBe("prompt-refused");
    expect(await used("generations")).toBe(before);

    // The provider drew it and will be paid for it, so a pin that fails afterwards does not undo
    // the spend and must not hand the slot back either.
    pinata = "refuses everything";
    const drawnThenLost = await generate("did:privy:slot-draw-b", "Drawn and not pinned");
    expect(drawnThenLost.statusCode).toBe(502);
    expect(await used("generations")).toBe(before + 1);
  }, 90_000);

  it("gives an edit slot back when nothing was pinned, and keeps it once the pins are paid for", async () => {
    const before = await used("edits");

    pinata = "refuses everything";
    const nothingPinned = await edit("did:privy:slot-edit-a", "nothing pinned");
    expect(nothingPinned.statusCode).toBe(502);
    expect(nothingPinned.json().error).toBe("pin-failed");
    expect(await used("edits")).toBe(before);

    // Four pins landed and then the registry refused the edit. Nothing was sent, which used to
    // hand the slot back, and four files of the plan had already been spent.
    pinata = "takes everything";
    const sentSoFar = stubs.send.mock.calls.length;
    stubs.estimateEditGas.mockRejectedValueOnce(new Error("execution reverted"));
    const pinnedThenRefused = await edit("did:privy:slot-edit-b", "pinned then refused");
    expect(pinnedThenRefused.statusCode).toBe(502);
    expect(pinnedThenRefused.json().error).toBe("send-failed");
    expect(stubs.send.mock.calls.length).toBe(sentSoFar);
    expect(await used("edits")).toBe(before + 1);
  }, 90_000);

  it("sends the picture, the thumbnail and the manifest to Pinata at once, then the metadata", async () => {
    steps = [];
    const response = await prepare("did:privy:slot-parallel", "Three at once");

    expect(response.statusCode).toBe(200);
    // Four pins in two waves: three uploads all in the air before the first of them came back,
    // then the metadata document, which cannot start until it knows where the other three landed.
    expect(steps).toEqual(["start", "start", "start", "end", "end", "end", "start", "end"]);
  }, 60_000);
});
