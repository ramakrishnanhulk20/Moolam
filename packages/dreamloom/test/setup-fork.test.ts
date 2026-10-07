// Runs Dreamloom's setup steps in their real order on a local anvil fork of Monad mainnet, against the
// live ERC-8004 identity registry and Moolam registry bytecode at their mainnet addresses: wallet.ts
// makes the key into a throwaway env file, the fork funds it, agent.ts registers the agent and the id
// is read back from the registry (its card read by the MCP server's own card reader), passkey.ts
// binds a key getPasskey reads back and rotates only on request, and the seed registers one picture
// through Dreamloom's own kit wrapper with the verify service and OpenAI stood in for.
// What this file does not cover: the real verify service (a stand-in on this machine answers the
// platform-mode prepare, with no C2PA, fingerprint or pin), a real OpenAI draw, the CLI wrappers that
// read packages/dreamloom/.env.local (never opened here), Monad's own gas prices and P-256 precompile,
// and the operator's side of onboarding (setup-refusals.test.ts). Nothing is sent to Monad mainnet.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import {
  AGENT_IDENTITY_REGISTRY,
  MOOLAM_CONSENT,
  MOOLAM_REGISTRY,
  ServerPasskey,
  passportDigest,
  platformIdOf,
  prepareDigest,
  sha256Hex,
} from "@moolam/platform";
import {
  createPublicClient,
  createTestClient,
  getAddress,
  http,
  parseEther,
  recoverAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { monad } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from "vitest";
import { AGENT_CARD, AGENT_CARD_DOCUMENT, registerAgent } from "../scripts/agent";
import { bindServerPasskey } from "../scripts/passkey";
import { SEED_MARKER, SEED_PICTURES, seedGallery } from "../scripts/seed";
import { createWallet } from "../scripts/wallet";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 240_000 });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const TSX_CLI = path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs");

// Only the RPC address is taken from the repo's root .env; nothing else in it enters this process.
// A fresh clone has no root .env, and then the suite is skipped.
const ROOT_ENV = path.join(REPO, ".env");
const rpcUrl = existsSync(ROOT_ENV)
  ? (parseEnv(readFileSync(ROOT_ENV, "utf8")) as Record<string, string>).MONAD_MAINNET_RPC_URL
  : undefined;
const skipReason = rpcUrl ? undefined : "create the repo root .env with MONAD_MAINNET_RPC_URL set";

if (skipReason !== undefined) it.skip(`skipped: to enable, ${skipReason}`, () => {});

const RP_ID = "dreamloom.example.com";
const PLATFORM_KEY = randomBytes(32).toString("hex");

const readAbi = [
  { type: "function", name: "ownerOf", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "tokenURI", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ name: "", type: "string" }] },
  {
    type: "function",
    name: "getPasskey",
    stateMutability: "view",
    inputs: [{ name: "wallet", type: "address" }],
    outputs: [
      { name: "qx", type: "bytes32" },
      { name: "qy", type: "bytes32" },
    ],
  },
  {
    type: "function",
    name: "getPassport",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "exactHash", type: "bytes32" },
          { name: "parentId", type: "bytes32" },
          { name: "creator", type: "address" },
          { name: "generatorAgentId", type: "uint256" },
          { name: "phash", type: "uint64" },
          { name: "blockhash256", type: "bytes32" },
          { name: "manifestHash", type: "bytes32" },
          { name: "kind", type: "uint8" },
          { name: "fingerprintVersion", type: "uint8" },
          { name: "registeredAt", type: "uint64" },
          { name: "disputed", type: "bool" },
          { name: "metadataURI", type: "string" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "consentOf",
    stateMutability: "view",
    inputs: [{ name: "passportId", type: "bytes32" }],
    outputs: [
      { name: "stated", type: "bool" },
      {
        name: "latest",
        type: "tuple",
        components: [
          { name: "at", type: "uint64" },
          { name: "writer", type: "address" },
          {
            name: "consent",
            type: "tuple",
            components: [
              { name: "aiTraining", type: "uint8" },
              { name: "aiGenerativeTraining", type: "uint8" },
              { name: "aiInference", type: "uint8" },
              { name: "dataMining", type: "uint8" },
            ],
          },
          { name: "constraintInfo", type: "string" },
        ],
      },
    ],
  },
] as const;

interface Fork {
  rpc: string;
  child: ChildProcess;
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createNetServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Anvil forking Monad mainnet on a free local port. Its output is never shown, because the fork URL
 * it may echo is a paid RPC address with its key in it.
 */
async function startFork(rpcUrl: string): Promise<Fork> {
  const local = path.join(homedir(), ".foundry", "bin", process.platform === "win32" ? "anvil.exe" : "anvil");
  const port = await freePort();
  const child = spawn(existsSync(local) ? local : "anvil", ["--fork-url", rpcUrl, "--chain-id", "143", "--port", String(port), "--host", "127.0.0.1"], {
    stdio: "ignore",
    windowsHide: true,
  });
  const rpc = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`anvil exited with code ${child.exitCode}`);
    try {
      const response = await fetch(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (((await response.json()) as { result?: string }).result !== undefined) return { rpc, child };
    } catch {
      // Not listening yet, which is normal for the first second or two.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  child.kill();
  throw new Error("anvil did not answer within 90 seconds");
}

function reply(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
}

function fakeCid(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  return `bafkrei${Array.from(randomBytes(52), (byte) => alphabet[byte % 32]).join("")}`;
}

/**
 * The verify service's platform-mode prepare, answered on this machine. It checks the platform key
 * and that the PlatformPrepare recovers to the agent's owner read from the fork, as the real route
 * does; its "signed file" is the picture with bytes appended, so the passport id is new to mainnet.
 */
class StandInService {
  base = "";
  prepares = 0;
  #server: Server | undefined;

  constructor(
    private readonly reader: PublicClient,
    private readonly agentId: () => bigint,
    private readonly creator: () => Address,
  ) {}

  async start(): Promise<void> {
    this.#server = createHttpServer((request, response) => {
      void this.#handle(request, response).catch((error: unknown) => reply(response, 500, { error: String(error) }));
    });
    await new Promise<void>((resolve) => this.#server?.listen(0, "127.0.0.1", resolve));
    this.base = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise((resolve) => this.#server?.close(resolve));
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    if (request.headers.authorization !== `Bearer ${PLATFORM_KEY}`) return reply(response, 401, { error: "unauthorized" });
    if (request.method !== "POST" || request.url !== "/platform/prepare") return reply(response, 404, { error: "not-found" });

    const form = await new Response(Buffer.concat(chunks), { headers: { "content-type": request.headers["content-type"] ?? "" } }).formData();
    const file = form.get("file");
    if (form.get("mode") !== "platform" || !(file instanceof Blob)) return reply(response, 400, { error: "platform mode only" });
    const picture = new Uint8Array(await file.arrayBuffer());
    const now = (await this.reader.getBlock({ blockTag: "latest" })).timestamp;
    const issuedAt = BigInt(form.get("issuedAt") as string);
    if (issuedAt > now + 60n || now - issuedAt > 600n) return reply(response, 403, { error: "prepare-expired" });
    const owner = await this.reader.readContract({ address: AGENT_IDENTITY_REGISTRY, abi: readAbi, functionName: "ownerOf", args: [this.agentId()] });
    const hash = prepareDigest({ mode: 0, pictureHash: sha256Hex(picture), platformId: platformIdOf(PLATFORM_KEY), nonce: form.get("nonce") as Hex, issuedAt });
    if ((await recoverAddress({ hash, signature: form.get("signature") as Hex })) !== getAddress(owner)) {
      return reply(response, 403, { error: "agent-signature-refused" });
    }
    this.prepares += 1;

    const signed = Buffer.concat([picture, Buffer.from("moolam-signed"), randomBytes(16)]);
    const files = { image: fakeCid(), thumbnail: fakeCid(), manifest: fakeCid(), metadata: fakeCid() };
    const deadline = now + 1800n;
    const input = {
      exactHash: sha256Hex(signed),
      parentId: `0x${"00".repeat(32)}` as Hex,
      creator: this.creator(),
      generatorAgentId: this.agentId(),
      phash: 0x336b806a7e894e76n,
      blockhash256: "0x000f003f187f3eff1878047c3c7d3c7b3e7f00ff01ff0007000300071fff3fff" as Hex,
      manifestHash: `0x${randomBytes(32).toString("hex")}` as Hex,
      kind: 0,
      fingerprintVersion: 1,
      metadataURI: `ipfs://${files.metadata}`,
      deadline,
    };
    const training = JSON.parse(form.get("training") as string) as Record<string, string>;
    return reply(response, 200, {
      mode: "platform",
      passport: {
        ...input,
        generatorAgentId: input.generatorAgentId.toString(),
        phash: input.phash.toString(),
        deadline: deadline.toString(),
      },
      digest: passportDigest(input),
      files: Object.fromEntries(
        Object.entries(files).map(([role, cid]) => [role, { cid, uri: `ipfs://${cid}`, gatewayUrl: `${this.base}/ipfs/${cid}`, bytes: 1000 }]),
      ),
      signedFile: { name: "picture.jpg", type: "image/jpeg", bytes: signed.toString("base64"), sha256: input.exactHash },
      training: { ...training, standard: "cawg.training-mining/1.1" },
      platform: { name: "Dreamloom", agentId: this.agentId().toString() },
    });
  }
}

let fork: Fork;
let reader: PublicClient;
let service: StandInService;
let workDir: string;
let envFile: string;
let wallet: Address;
let walletKey: string;
let agentId: bigint;
let consoleSpies: MockInstance[];

function envValues(): Record<string, string> {
  return parseEnv(readFileSync(envFile, "utf8")) as Record<string, string>;
}

async function nonce(): Promise<number> {
  return await reader.getTransactionCount({ address: wallet });
}

beforeAll(async () => {
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method));
  if (!rpcUrl) return;
  fork = await startFork(rpcUrl);
  reader = createPublicClient({ chain: monad, transport: http(fork.rpc) }) as PublicClient;
  workDir = mkdtempSync(path.join(tmpdir(), "dreamloom-setup-"));
  envFile = path.join(workDir, ".env.test");
  service = new StandInService(reader, () => agentId, () => wallet);
  await service.start();
});

afterAll(async () => {
  for (const spy of consoleSpies ?? []) spy.mockRestore();
  await service?.stop();
  fork?.child.kill();
  if (workDir !== undefined) rmSync(workDir, { recursive: true, force: true });
});

describe.skipIf(skipReason !== undefined)("Dreamloom's setup, step by step on a fork", () => {
  it("wallet.ts writes a fresh key into the env file and hands back only its address", async () => {
    ({ address: wallet } = createWallet({ envFile }));
    walletKey = envValues().DREAMLOOM_WALLET_KEY as string;
    expect(walletKey).toMatch(/^0x[0-9a-f]{64}$/);
    // Anvil's published accounts carry live delegations on Monad that sweep what is paid to them, so
    // the fresh wallet is funded on the fork directly.
    await createTestClient({ mode: "anvil", chain: monad, transport: http(fork.rpc) }).setBalance({ address: wallet, value: parseEther("1.5") });
    expect(await nonce()).toBe(0);
  });

  it("agent.ts registers the agent from the wallet and the registry reads its id back", async () => {
    const result = await registerAgent({ envFile, walletKey, rpcUrl: fork.rpc });
    agentId = result.agentId;

    expect(result.wallet).toBe(wallet);
    expect((await reader.getTransactionReceipt({ hash: result.tx })).status).toBe("success");
    expect(await reader.readContract({ address: AGENT_IDENTITY_REGISTRY, abi: readAbi, functionName: "ownerOf", args: [agentId] })).toBe(wallet);
    expect(await reader.readContract({ address: AGENT_IDENTITY_REGISTRY, abi: readAbi, functionName: "tokenURI", args: [agentId] })).toBe(AGENT_CARD);
    expect(envValues().DREAMLOOM_AGENT_ID).toBe(agentId.toString());
  });

  it("the card on chain passes the MCP server's own card reader", () => {
    const code =
      'import { liveCardReader } from "./src/mcp/agentCard.ts";' +
      "liveCardReader()(process.env.CARD_URI).then((answer) => console.log(JSON.stringify(answer)));";
    const child = spawnSync(process.execPath, [TSX_CLI, "--eval", code], {
      cwd: path.join(REPO, "packages", "verifier"),
      env: { ...process.env, CARD_URI: AGENT_CARD },
      encoding: "utf8",
      timeout: 120_000,
    });
    const answer = JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "null") as { status: string; card?: Record<string, unknown> };
    expect(answer.status).toBe("card");
    expect(answer.card).toMatchObject({ name: AGENT_CARD_DOCUMENT.name, description: AGENT_CARD_DOCUMENT.description, services: [], active: true });
  });

  it("agent.ts refuses a second registration once the id is written, sending nothing", async () => {
    const before = await nonce();
    await expect(registerAgent({ envFile, walletKey, rpcUrl: fork.rpc })).rejects.toThrow(/DREAMLOOM_AGENT_ID is already set/);
    expect(await nonce()).toBe(before);
  });

  it("passkey.ts binds a server passkey that getPasskey reads back, and writes only its key", async () => {
    const bound = await bindServerPasskey({ envFile, walletKey, rpcUrl: fork.rpc, rpId: RP_ID, rotate: false });
    const saved = envValues().DREAMLOOM_PASSKEY_KEY as Hex;
    const passkey = ServerPasskey.fromPrivateKey(saved, RP_ID);

    expect(bound).toMatchObject({ wallet, rpId: RP_ID, qx: passkey.qx, qy: passkey.qy });
    expect(JSON.stringify(bound)).not.toContain(saved.slice(2));
    const [qx, qy] = await reader.readContract({ address: MOOLAM_REGISTRY, abi: readAbi, functionName: "getPasskey", args: [wallet] });
    expect([qx, qy]).toEqual([passkey.qx, passkey.qy]);
  });

  it("passkey.ts refuses to replace the key without --rotate, and replaces it with it", async () => {
    const before = await nonce();
    const first = envValues().DREAMLOOM_PASSKEY_KEY;
    await expect(bindServerPasskey({ envFile, walletKey, rpcUrl: fork.rpc, rpId: RP_ID, rotate: false })).rejects.toThrow(/pass --rotate/);
    await expect(bindServerPasskey({ envFile, walletKey, rpcUrl: fork.rpc, rpId: "localhost", rotate: true })).rejects.toThrow(/DREAMLOOM_PASSKEY_RP_ID/);
    expect(await nonce()).toBe(before);
    expect(envValues().DREAMLOOM_PASSKEY_KEY).toBe(first);

    const rotated = await bindServerPasskey({ envFile, walletKey, rpcUrl: fork.rpc, rpId: RP_ID, rotate: true });
    const saved = envValues().DREAMLOOM_PASSKEY_KEY as Hex;
    expect(saved).not.toBe(first);
    const [qx, qy] = await reader.readContract({ address: MOOLAM_REGISTRY, abi: readAbi, functionName: "getPasskey", args: [wallet] });
    expect([qx, qy]).toEqual([rotated.qx, rotated.qy]);
    expect(ServerPasskey.fromPrivateKey(saved, RP_ID).qx).toBe(rotated.qx);
  });

  it("the seed registers a picture through Dreamloom's kit wrapper in platform mode with the noAi terms", async () => {
    const values = envValues();
    const dataDir = path.join(workDir, "data");
    // lib/server/kit.ts reads its settings from process.env; they are set here, in this test's own
    // process, and packages/dreamloom/.env.local is never read. No OpenAI key exists, so a real draw
    // could not happen even by mistake.
    Object.assign(process.env, {
      MOOLAM_VERIFY_URL: service.base,
      MOOLAM_SITE_URL: "https://moolam.site",
      MONAD_RPC_URL: fork.rpc,
      DREAMLOOM_WALLET_KEY: values.DREAMLOOM_WALLET_KEY,
      DREAMLOOM_PASSKEY_KEY: values.DREAMLOOM_PASSKEY_KEY,
      DREAMLOOM_PASSKEY_RP_ID: RP_ID,
      DREAMLOOM_PLATFORM_KEY: PLATFORM_KEY,
      DATA_DIR: dataDir,
    });
    delete process.env.OPENAI_API_KEY;
    const [first] = SEED_PICTURES;
    if (first === undefined) throw new Error("no seed pictures");
    const drawn: string[] = [];
    const draw = async (prompt: string) => {
      drawn.push(prompt);
      return { bytes: new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), randomBytes(64)])) };
    };

    const seeded = await seedGallery({ dataDir, pictures: [first], draw });

    expect(drawn).toEqual([first.prompt]);
    expect(service.prepares).toBe(1);
    const [picture] = seeded;
    if (picture === undefined) throw new Error("nothing was seeded");
    const onChain = await reader.readContract({ address: MOOLAM_REGISTRY, abi: readAbi, functionName: "getPassport", args: [picture.passportId] });
    expect(onChain.creator).toBe(wallet);
    expect(onChain.generatorAgentId).toBe(agentId);
    expect(await reader.readContract({ address: MOOLAM_REGISTRY, abi: readAbi, functionName: "ownerOf", args: [BigInt(picture.passportId)] })).toBe(wallet);
    const [stated, latest] = await reader.readContract({ address: MOOLAM_CONSENT, abi: readAbi, functionName: "consentOf", args: [picture.passportId] });
    expect(stated).toBe(true);
    expect(latest.writer).toBe(wallet);
    expect(latest.consent).toEqual({ aiTraining: 2, aiGenerativeTraining: 2, aiInference: 2, dataMining: 2 });

    const marker = JSON.parse(readFileSync(path.join(dataDir, SEED_MARKER), "utf8")) as { seeded: unknown[]; stoppedAt?: unknown };
    expect(marker.seeded).toEqual([picture]);
    expect(marker.stoppedAt).toBeUndefined();

    const before = await nonce();
    await expect(seedGallery({ dataDir, pictures: [first], draw })).rejects.toThrow(/already seeded/);
    expect(drawn).toHaveLength(1);
    expect(await nonce()).toBe(before);
  });

  it("the seed stops at the first failure and records it, spending nothing after it", async () => {
    const dataDir = path.join(workDir, "stopped");
    const draws: string[] = [];
    const draw = async (prompt: string) => {
      draws.push(prompt);
      throw Object.assign(new Error("the provider is down"), { name: "APIConnectionError" });
    };
    await expect(seedGallery({ dataDir, draw, register: () => Promise.reject(new Error("never called")) })).rejects.toThrow(/provider is down/);
    expect(draws).toHaveLength(1);
    const marker = JSON.parse(readFileSync(path.join(dataDir, SEED_MARKER), "utf8")) as { seeded: unknown[]; stoppedAt?: unknown };
    expect(marker).toMatchObject({ seeded: [], stoppedAt: { title: SEED_PICTURES[0]?.title, reason: "APIConnectionError" } });
  });

  it("left exactly the three values in the env file and printed nothing", () => {
    expect(Object.keys(envValues()).sort()).toEqual(["DREAMLOOM_AGENT_ID", "DREAMLOOM_PASSKEY_KEY", "DREAMLOOM_WALLET_KEY"]);
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });
});
