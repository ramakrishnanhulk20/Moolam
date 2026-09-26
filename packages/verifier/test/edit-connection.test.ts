// Covers how POST /edit tells a caller who is still waiting from one who hung up (V2), over a real
// HTTP connection on this machine. inject() cannot show this: its request stream never closes on
// its own, while a real server request closes as soon as its body has been read, with the caller
// still waiting for the answer. A caller who waits gets the edit; a caller who closes the socket
// while the picture is being prepared is not sent for.
// Does NOT cover Privy, the chain or Pinata: all three are stubbed exactly as test/edit.test.ts
// stubs them, and the edit's own rules are tested there.

import { request as httpRequest, type ClientRequest } from "node:http";
import { SignJWT, generateKeyPair } from "jose";
import { decodeFunctionData, getAddress, toEventSelector, type Hex } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { makeImage } from "./helpers.js";

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
  process.env.EDITS_PER_DAY = "20";
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
}));

vi.mock("../src/edit/signers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/edit/signers.js")>()),
  delegatedWallets: stubs.delegatedWallets,
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
  awaitReceipt: stubs.receipt,
}));

vi.mock("../src/generate/privy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/generate/privy.js")>()),
  privy: () => ({}),
  ownerContext: () => ({}),
}));

const { registryEditAbi } = await import("../src/edit/registry.js");
const { contentIdOf } = await import("../src/ipfs/pinata.js");
const { env } = await import("../src/env.js");
const { buildServer } = await import("../src/server.js");

const UPLOAD_URL = "https://uploads.pinata.cloud/v3/files";
const OWNER = getAddress("0x85a88ca81ff5f681d96ab86fa60ccb8452a139a6");
const PARENT = `0x${"ab".repeat(32)}` as Hex;
const HASH = `0x${"11".repeat(32)}` as Hex;
const PASSPORT_REGISTERED = toEventSelector(
  "PassportRegistered(bytes32,address,uint256,bytes32,uint64,bytes32,bytes32,uint8,uint8,string)",
);

let signing: CryptoKey;
let verifying: CryptoKey;
let app: FastifyInstance;
let port: number;
let picture: Buffer;
/** Stands in for the shared prepare gate, so a test can hold the route while the caller hangs up. */
let prepareGate: (task: () => Promise<unknown>) => Promise<unknown> = async (task) => await task();

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

function editBody(content: Buffer): { payload: Buffer; contentType: string } {
  const boundary = "----moolamlivedit";
  const fields = { title: "Monsoon nets, brightened", parentId: PARENT, note: "brightened the sky" };
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="edited.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return { payload: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Sends one edit over a real socket. Hands back the request, so a test can hang up on it. */
async function post(subject: string): Promise<{ request: ClientRequest; answer: Promise<{ status: number; body: string }> }> {
  const { payload, contentType } = editBody(picture);
  const bearer = await token(subject);
  let request: ClientRequest | undefined;
  const answer = new Promise<{ status: number; body: string }>((resolve, reject) => {
    request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/edit",
        headers: { "content-type": contentType, "content-length": payload.length, authorization: `Bearer ${bearer}` },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    request.on("error", reject);
    request.end(payload);
  });
  return { request: request as unknown as ClientRequest, answer };
}

describe("POST /edit over a real connection (V2)", () => {
  beforeAll(async () => {
    const pair = await generateKeyPair("ES256", { extractable: true });
    signing = pair.privateKey;
    verifying = pair.publicKey;
    picture = await makeImage(14);

    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== UPLOAD_URL) {
        return await realFetch(input, init);
      }
      const file = (init?.body as FormData).get("file") as File;
      const bytes = Buffer.from(await file.arrayBuffer());
      return new Response(
        JSON.stringify({ data: { cid: contentIdOf(bytes), size: bytes.length, network: "public" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    app = await buildServer({ source: { load: async () => [] }, logger: false, edit: { keys: verifying } });
    app.verifier.runPrepare = ((task: () => Promise<unknown>) => prepareGate(task)) as typeof app.verifier.runPrepare;
    await app.listen({ port: 0, host: "127.0.0.1" });
    port = (app.server.address() as { port: number }).port;
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await app.close();
  });

  beforeEach(() => {
    prepareGate = async (task) => await task();
    stubs.passportExists.mockReset().mockImplementation(async (_chain, _registry, id: Hex) => id === PARENT);
    stubs.delegatedWallets.mockReset().mockResolvedValue([{ id: "privy-wallet-1", address: OWNER }]);
    stubs.walletSigners.mockReset().mockResolvedValue([{ signerId: SETTINGS.signerId, policyIds: [SETTINGS.policyId] }]);
    stubs.parentOwner.mockReset().mockResolvedValue(OWNER);
    stubs.estimateEditGas.mockReset().mockResolvedValue(420_000n);
    stubs.send.mockReset().mockResolvedValue({ hash: HASH, sponsored: true, transactionId: "privy-tx-1" });
    // The receipt carries the registry's own event for the child the send was built for.
    stubs.receipt.mockReset().mockImplementation(async () => {
      const sent = stubs.send.mock.lastCall?.[2] as { data: Hex };
      const [input] = decodeFunctionData({ abi: registryEditAbi, data: sent.data }).args as unknown as [{ exactHash: Hex }];
      return {
        status: "success",
        logs: [{ address: env.MOOLAM_REGISTRY_ADDRESS as Hex, topics: [PASSPORT_REGISTERED, input.exactHash] }],
      };
    });
  });

  it("answers a caller who waits, rather than calling them gone once their upload is read", async () => {
    const { answer } = await post("did:privy:live-waiting");
    const { status, body } = await answer;

    expect(status, body).toBe(200);
    expect(JSON.parse(body).hash).toBe(HASH);
    expect(stubs.send).toHaveBeenCalledTimes(1);
  }, 60_000);

  it("sends nothing for a caller who hung up while the picture was being prepared", async () => {
    let entered: () => void = () => undefined;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    prepareGate = async (task) => {
      entered();
      await held;
      return await task();
    };
    let checked: () => void = () => undefined;
    const estimated = new Promise<void>((resolve) => {
      checked = resolve;
    });
    stubs.estimateEditGas.mockImplementation(async () => {
      checked();
      return 420_000n;
    });

    const { request, answer } = await post("did:privy:live-hangs-up");
    answer.catch(() => undefined);
    await inside;
    request.destroy();
    await new Promise((resolve) => setTimeout(resolve, 150));
    release();
    await Promise.race([estimated, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(stubs.estimateEditGas).toHaveBeenCalledTimes(1);
    expect(stubs.send).not.toHaveBeenCalled();
  }, 60_000);
});
