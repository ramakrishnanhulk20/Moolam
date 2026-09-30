// Covers the kit end to end on a local anvil fork of Monad mainnet, against the live registry,
// consent and ERC-8004 bytecode at their mainnet addresses: setupPlatform binds a server passkey
// from a fresh wallet and refuses a second bind and a wallet holding passports (P20); a platform-mode
// register with a fresh ERC-8004 agent lands with its terms stated (P19, P24), and a service that
// lies about the digest or the signed file is refused before any transaction; a co-sign register
// where the person's passkey is also simulated in software; transferPassport and each refusal (P22);
// and, across all of it, that the passkey's private key never leaves the process and the platform
// key travels only in the verify service's Authorization header (P7, P21).
// Does NOT cover the real verify service (mocked at the HTTP level, see support/mock-service.ts; its
// routes have their own tests), a real C2PA manifest, pin or fingerprint, the Moolam co-sign page in
// a browser, Monad's own P-256 precompile (anvil runs the fork), or mainnet gas prices. Nothing here
// sends a transaction to Monad mainnet: every write goes to the local fork.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  parseEther,
  parseEventLogs,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from "vitest";
import { startAnvilFork, type AnvilFork } from "@moolam/agents/src/chain/anvil.js";
import { SoftwarePasskey } from "@moolam/agents/src/chain/passkey.js";
import { consentAbi, registryAbi } from "../src/abi.js";
import { AGENT_IDENTITY_REGISTRY, MOOLAM_CONSENT, MOOLAM_REGISTRY } from "../src/constants.js";
import { bindDigest, passportDigest } from "../src/eip712.js";
import {
  ServerPasskey,
  registerAsPlatform,
  setupPlatform,
  signAsAgent,
  startCosign,
  transferPassport,
  waitForCreator,
  waitForPassport,
  type AiUseTerms,
  type PlatformSetup,
  type PlatformWalletClient,
} from "../src/index.js";
import { sha256Hex } from "../src/prepare.js";
import { MockVerifyService } from "./support/mock-service.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PICTURE = readFileSync(join(HERE, "..", "..", "verifier", "test-assets", "original.jpg"));
const RP_ID = "images.example-platform.com";
const PLATFORM_KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
const TERMS: AiUseTerms = { aiTraining: "notAllowed", aiInference: "constrained", constraintInfo: "Ask licensing@example-platform.com" };
const AGENT_CARD =
  'data:application/json,{"type":"https://eips.ethereum.org/EIPS/eip-8004#registration-v1","name":"Example Platform generator","services":[],"active":true}';

const identityRegisterAbi = [
  { type: "function", name: "register", stateMutability: "nonpayable", inputs: [{ name: "agentURI", type: "string" }], outputs: [{ name: "agentId", type: "uint256" }] },
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
    ],
  },
] as const;

const consentReadAbi = [
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

interface Sent {
  url: string;
  authorization: string | null;
  body: string;
}

let fork: AnvilFork;
let reader: PublicClient;
let service: MockVerifyService;
let platformAccount: PrivateKeyAccount;
let agentOwner: PrivateKeyAccount;
let person: PrivateKeyAccount;
let platformWallet: PlatformWalletClient;
let personWallet: PlatformWalletClient;
let agentId: bigint;
let setup: PlatformSetup;
let passkey: ServerPasskey;
let platformPassport: Hex;
let cosignedPassport: Hex;
const sent: Sent[] = [];
const gas: Record<string, bigint> = {};
let fetchSpy: MockInstance<typeof fetch>;
let consoleSpies: MockInstance[];

async function gasOf(label: string, hash: Hex): Promise<void> {
  gas[label] = (await reader.getTransactionReceipt({ hash })).gasUsed;
}

/** The same address with one letter's case flipped: a typo getAddress must refuse, never guess past. */
function wrongChecksum(address: Address): string {
  const at = address.slice(2).search(/[a-fA-F]/) + 2;
  const letter = address.charAt(at);
  const flipped = letter === letter.toUpperCase() ? letter.toLowerCase() : letter.toUpperCase();
  return `${address.slice(0, at)}${flipped}${address.slice(at + 1)}`;
}

async function nonceOf(address: Address): Promise<number> {
  return await reader.getTransactionCount({ address });
}

beforeAll(async () => {
  const realFetch = globalThis.fetch;
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    let body = "";
    if (typeof init?.body === "string") body = init.body;
    else if (init?.body instanceof FormData) {
      body = [...init.body.entries()].map(([name, value]) => `${name}=${typeof value === "string" ? value : "<file>"}`).join("&");
    }
    sent.push({ url, authorization: headers.get("authorization"), body });
    return await realFetch(input, init);
  });
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method));

  const rpcUrl = process.env.MONAD_MAINNET_RPC_URL;
  if (!rpcUrl) throw new Error("MONAD_MAINNET_RPC_URL is not set in the repo root .env, so there is no Monad mainnet to fork.");
  fork = await startAnvilFork(rpcUrl);
  const chain = defineChain({
    id: 143,
    name: "Monad mainnet fork",
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [fork.rpc] } },
  });
  reader = createPublicClient({ chain, transport: http(fork.rpc) });
  const tester = createTestClient({ mode: "anvil", chain, transport: http(fork.rpc) });

  platformAccount = privateKeyToAccount(generatePrivateKey());
  agentOwner = privateKeyToAccount(generatePrivateKey());
  person = privateKeyToAccount(generatePrivateKey());
  for (const account of [platformAccount, agentOwner, person]) {
    await tester.setBalance({ address: account.address, value: parseEther("5") });
  }
  platformWallet = createWalletClient({ account: platformAccount, chain, transport: http(fork.rpc) });
  personWallet = createWalletClient({ account: person, chain, transport: http(fork.rpc) });

  const agentWallet = createWalletClient({ account: agentOwner, chain, transport: http(fork.rpc) });
  const minted = await agentWallet.writeContract({ address: AGENT_IDENTITY_REGISTRY, abi: identityRegisterAbi, functionName: "register", args: [AGENT_CARD] });
  const receipt = await reader.waitForTransactionReceipt({ hash: minted });
  const [transfer] = parseEventLogs({ abi: identityRegisterAbi, eventName: "Transfer", logs: receipt.logs }).filter(
    (log) => getAddress(log.address) === AGENT_IDENTITY_REGISTRY && log.args.to === agentOwner.address,
  );
  if (transfer === undefined) throw new Error("no ERC-8004 agent was minted on the fork");
  agentId = transfer.args.tokenId;

  service = new MockVerifyService({ platformKey: PLATFORM_KEY, agentId, creatorWallet: platformAccount.address, reader });
  await service.start();
});

afterAll(async () => {
  fetchSpy?.mockRestore();
  for (const spy of consoleSpies ?? []) spy.mockRestore();
  await service?.stop();
  await fork?.stop();
  if (Object.keys(gas).length > 0) {
    console.info(`gas used on the fork: ${Object.entries(gas).map(([label, used]) => `${label} ${used}`).join(", ")}`);
  }
});

describe("setupPlatform", () => {
  it("refuses Moolam's hostname and localhost before touching the chain", async () => {
    await expect(setupPlatform({ walletClient: platformWallet, rpId: "moolam.vercel.app" })).rejects.toMatchObject({ code: "invalid-rp-id" });
    await expect(setupPlatform({ walletClient: platformWallet, rpId: "localhost" })).rejects.toMatchObject({ code: "invalid-rp-id" });
    expect(await nonceOf(platformAccount.address)).toBe(0);
  });

  it("binds a fresh server passkey from the platform's own wallet", async () => {
    setup = await setupPlatform({ walletClient: platformWallet, rpId: RP_ID });
    passkey = ServerPasskey.fromPrivateKey(setup.passkeyPrivateKey, setup.rpId);
    await gasOf("bindPasskey", setup.bindTx);

    expect(setup.wallet).toBe(platformAccount.address);
    expect([setup.qx, setup.qy]).toEqual([passkey.qx, passkey.qy]);
    const [qx, qy] = await reader.readContract({ address: MOOLAM_REGISTRY, abi: registryAbi, functionName: "getPasskey", args: [platformAccount.address] });
    expect([qx, qy]).toEqual([passkey.qx, passkey.qy]);
  });

  it("refuses to overwrite the binding without rotate", async () => {
    const before = await nonceOf(platformAccount.address);
    await expect(setupPlatform({ walletClient: platformWallet, rpId: RP_ID })).rejects.toMatchObject({ code: "passkey-already-bound" });
    expect(await nonceOf(platformAccount.address)).toBe(before);
  });
});

describe("registerAsPlatform", () => {
  it("registers a picture in platform mode against the live registry and states the same terms", async () => {
    const result = await registerAsPlatform(PICTURE, {
      verifyUrl: service.base,
      platformKey: PLATFORM_KEY,
      agentAccount: agentOwner,
      passkey,
      walletClient: platformWallet,
      title: "A lighthouse at dusk",
      terms: TERMS,
    });
    platformPassport = result.passportId;
    await gasOf("register", result.registerTx);
    await gasOf("setConsent", result.consentTx as Hex);

    expect(sha256Hex(result.signedFile)).toBe(result.passportId);
    const onChain = await reader.readContract({ address: MOOLAM_REGISTRY, abi: registryAbi, functionName: "getPassport", args: [result.passportId] });
    expect(onChain.creator).toBe(platformAccount.address);
    expect(onChain.generatorAgentId).toBe(agentId);
    expect(onChain.kind).toBe(0);
    expect(await reader.readContract({ address: MOOLAM_REGISTRY, abi: registryAbi, functionName: "ownerOf", args: [BigInt(result.passportId)] })).toBe(
      platformAccount.address,
    );

    const [stated, latest] = await reader.readContract({ address: MOOLAM_CONSENT, abi: consentReadAbi, functionName: "consentOf", args: [result.passportId] });
    expect(stated).toBe(true);
    expect(latest.writer).toBe(platformAccount.address);
    expect(latest.consent).toEqual({ aiTraining: 2, aiGenerativeTraining: 0, aiInference: 3, dataMining: 0 });
    expect(latest.constraintInfo).toBe(TERMS.constraintInfo);
  });

  it("refuses a service digest that is not the digest of its own fields, and sends nothing", async () => {
    const before = await nonceOf(platformAccount.address);
    service.tamper = "digest";
    const options = { verifyUrl: service.base, platformKey: PLATFORM_KEY, agentAccount: agentOwner, passkey, walletClient: platformWallet, title: "Tampered", terms: TERMS };
    await expect(registerAsPlatform(PICTURE, options)).rejects.toMatchObject({ code: "digest-mismatch" });
    service.tamper = "signed-file";
    await expect(registerAsPlatform(PICTURE, options)).rejects.toMatchObject({ code: "signed-file-mismatch" });
    service.tamper = "terms";
    await expect(registerAsPlatform(PICTURE, options)).rejects.toMatchObject({ code: "terms-mismatch" });
    service.tamper = null;
    expect(await nonceOf(platformAccount.address)).toBe(before);
  });

  it("refuses to set up again on a wallet that now holds passports, even with rotate", async () => {
    await expect(setupPlatform({ walletClient: platformWallet, rpId: RP_ID, rotate: true })).rejects.toMatchObject({ code: "wallet-holds-passports" });
  });
});

describe("co-sign", () => {
  it("registers a picture the person co-signs with their own passkey", async () => {
    const handle = await startCosign(PICTURE, {
      verifyUrl: service.base,
      platformKey: PLATFORM_KEY,
      agentAccount: agentOwner,
      publicClient: reader,
      title: "A harbour in fog",
      terms: TERMS,
    });
    expect(handle.cosignUrl).toBe(`https://moolam.vercel.app/cosign/${handle.handle}`);
    expect(JSON.stringify(handle)).not.toContain(PLATFORM_KEY);

    const waiting = waitForCreator(handle, { pollMs: 100, timeoutMs: 30_000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await service.openAs(handle.handle, person.address);
    const digest = await waiting;
    await expect(signAsAgent(handle, `0x${"00".repeat(32)}`)).rejects.toMatchObject({ code: "digest-mismatch" });
    await signAsAgent(handle, digest);

    // What the Moolam co-sign page does in the person's browser: bind their passkey once, then sign
    // the digest it rebuilt from the fields it drew and send register from their wallet.
    const personKey = SoftwarePasskey.random({ rpId: "moolam.vercel.app" });
    const nonce = await reader.readContract({ address: MOOLAM_REGISTRY, abi: registryAbi, functionName: "bindNonce", args: [person.address] });
    const bindAuth = personKey.sign(bindDigest(person.address, personKey.qx, personKey.qy, nonce));
    await reader.waitForTransactionReceipt({
      hash: await personWallet.writeContract({ address: MOOLAM_REGISTRY, abi: registryAbi, functionName: "bindPasskey", args: [personKey.qx, personKey.qy, bindAuth] }),
    });
    const record = service.records.get(handle.handle);
    if (record?.creator === undefined || record.deadline === undefined || record.agentSignature === undefined) throw new Error("the record was not signed");
    const input = {
      exactHash: record.fields.exactHash as Hex,
      parentId: record.fields.parentId as Hex,
      creator: record.creator,
      generatorAgentId: BigInt(record.fields.generatorAgentId as string),
      phash: BigInt(record.fields.phash as string),
      blockhash256: record.fields.blockhash256 as Hex,
      manifestHash: record.fields.manifestHash as Hex,
      kind: 0,
      fingerprintVersion: 1,
      metadataURI: record.fields.metadataURI as string,
      deadline: record.deadline,
    };
    expect(passportDigest(input)).toBe(digest);
    const registered = await personWallet.writeContract({
      address: MOOLAM_REGISTRY,
      abi: registryAbi,
      functionName: "register",
      args: [input, personKey.sign(digest), record.agentSignature],
    });
    expect((await reader.waitForTransactionReceipt({ hash: registered })).status).toBe("success");

    const passport = await waitForPassport(handle, { pollMs: 100, timeoutMs: 30_000 });
    cosignedPassport = passport.passportId;
    expect(passport.creator).toBe(person.address);
    expect(passport.passportId).toBe(handle.passportId);
    expect(await reader.readContract({ address: MOOLAM_REGISTRY, abi: registryAbi, functionName: "ownerOf", args: [BigInt(passport.passportId)] })).toBe(person.address);
  });
});

describe("transferPassport", () => {
  it("refuses the zero address, the platform's own wallet, the registry and a bad address, sending nothing", async () => {
    const before = await nonceOf(platformAccount.address);
    const refused: [string, string][] = [
      ["0x0000000000000000000000000000000000000000", "refused-recipient"],
      [platformAccount.address.toLowerCase(), "refused-recipient"],
      [MOOLAM_REGISTRY.toLowerCase(), "refused-recipient"],
      ["0x1234", "invalid-input"],
      [wrongChecksum(person.address), "invalid-input"],
    ];
    for (const [to, code] of refused) {
      await expect(transferPassport(platformPassport, to, platformWallet), to).rejects.toMatchObject({ code });
    }
    await expect(transferPassport(cosignedPassport, person.address, platformWallet)).rejects.toMatchObject({ code: "not-holder" });
    await expect(transferPassport(platformPassport, MOOLAM_CONSENT, platformWallet)).rejects.toMatchObject({ code: "transaction-failed" });
    expect(await nonceOf(platformAccount.address)).toBe(before);
  });

  it("moves the passport to a checked address and answers only from the receipt", async () => {
    const result = await transferPassport(platformPassport, person.address.toLowerCase(), platformWallet);
    await gasOf("safeTransferFrom", result.txHash);

    expect(result).toMatchObject({ passportId: platformPassport, from: platformAccount.address, to: person.address });
    expect((await reader.getTransactionReceipt({ hash: result.txHash })).status).toBe("success");
    expect(await reader.readContract({ address: MOOLAM_REGISTRY, abi: registryAbi, functionName: "ownerOf", args: [BigInt(platformPassport)] })).toBe(person.address);
  });
});

describe("what left the process", () => {
  it("never sent the passkey's private key anywhere, and sent the platform key only in the service's Authorization header", () => {
    const privateHex = setup.passkeyPrivateKey.slice(2).toLowerCase();
    expect(sent.length).toBeGreaterThan(20);
    for (const one of sent) {
      expect(`${one.url} ${one.authorization ?? ""} ${one.body}`.toLowerCase()).not.toContain(privateHex);
      expect(one.url).not.toContain(PLATFORM_KEY);
      expect(one.body).not.toContain(PLATFORM_KEY);
      const toService = one.url.startsWith(service.base) && !one.url.startsWith(`${service.base}/ipfs/`);
      expect(one.authorization).toBe(toService ? `Bearer ${PLATFORM_KEY}` : null);
    }
    expect(service.seen.filter((one) => one.url.startsWith("/ipfs/")).every((one) => one.authorization === undefined)).toBe(true);
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });
});
