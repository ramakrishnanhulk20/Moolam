// What this file does NOT cover: Monad's own P-256 precompile at 0x0100 and its gas price, which
// only a real mainnet transaction exercises; the Chainlink attestation path, which the contracts
// package proves; and the dispute money flow. It also does not spend MON: everything here runs
// against a local anvil fork of Monad mainnet state, so the ERC-8004 registry is the real one but
// the balances are anvil's.

import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  recoverAddress,
  toHex,
  type Hex,
  type PublicClient,
} from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  anvilAccount,
  anvilPrivateKey,
  deployToFork,
  monadFork,
  startAnvilFork,
  type AnvilFork,
} from "../src/chain/anvil.js";
import type { Addresses } from "../src/chain/addresses.js";
import { bindDigest, Kind, passportDigest, type PassportInput } from "../src/chain/eip712.js";
import { SoftwarePasskey } from "../src/chain/passkey.js";
import { RegistryClient } from "../src/chain/registry.js";

const ZERO_BYTES32 = `0x${"00".repeat(32)}` as Hex;

// Real fingerprints of packages/verifier/test-assets, measured by the verifier spike and recorded
// in proofs/spike.txt. Using the measured numbers keeps the digests honest.
const ORIGINAL_SHA256 = "0xb95adc0cf9b3bb3af90bafa247b5a49dd5c5d50877537b47f7b000c5a573354c" as Hex;
const ORIGINAL_PHASH = 0x336b806a7e894e76n;
const ORIGINAL_BLOCKHASH =
  "0x000f003f187f3eff1878047c3c7d3c7b3e7f00ff01ff0007000300071fff3fff" as Hex;
const SIGNED_SHA256 = "0x7b4732f365aa235556b4b11b8916fd544f10acc034ae7e0b9e39068becae1a50" as Hex;
const SIGNED_MANIFEST_HASH =
  "0x43e6e3a61c1e49aae9135e12b0a6b354d0c56a27f11ca1cb2489cc5222e24e62" as Hex;
const STRIPPED_SHA256 = "0x9f0f2bde58513560923b5883ded38af5f13a15879f144fb17e44adde17252c35" as Hex;

const AGENT_CARD =
  'data:application/json,{"type":"https://eips.ethereum.org/EIPS/eip-8004#registration-v1",' +
  '"name":"Moolam test generator","description":"Signs the fingerprint of every image it makes.",' +
  '"services":[],"active":true}';

const creatorAccount = anvilAccount(1);
const agentOwnerAccount = anvilAccount(2);
const strangerAccount = anvilAccount(3);

let fork: AnvilFork;
let addresses: Addresses;
let publicClient: PublicClient;
let creator: RegistryClient;
let agentOwner: RegistryClient;
let stranger: RegistryClient;
let passkey: SoftwarePasskey;
let deadline: bigint;
let agentId: bigint;

function input(overrides: Partial<PassportInput> = {}): PassportInput {
  return {
    exactHash: ORIGINAL_SHA256,
    parentId: ZERO_BYTES32,
    creator: creatorAccount.address,
    generatorAgentId: 0n,
    phash: ORIGINAL_PHASH,
    blockhash256: ORIGINAL_BLOCKHASH,
    manifestHash: ZERO_BYTES32,
    kind: Kind.Captured,
    fingerprintVersion: 1,
    metadataURI: "ipfs://bafkreiggnfemzyzzrs6ba2ycklbfghbmpwd6mmzcy3rxhh4ovfxkfvvzsm",
    deadline,
    ...overrides,
  };
}

beforeAll(async () => {
  const rpcUrl = process.env.MONAD_MAINNET_RPC_URL;
  if (!rpcUrl) {
    throw new Error("MONAD_MAINNET_RPC_URL is not set, so there is no Monad mainnet to fork.");
  }

  fork = await startAnvilFork(rpcUrl);
  addresses = await deployToFork(fork.rpc, anvilPrivateKey(0));

  const chain = monadFork(fork.rpc);
  publicClient = createPublicClient({ chain, transport: http(fork.rpc) });

  const client = (account: typeof creatorAccount) =>
    new RegistryClient({
      publicClient,
      walletClient: createWalletClient({ account, chain, transport: http(fork.rpc) }),
      addresses,
    });

  creator = client(creatorAccount);
  agentOwner = client(agentOwnerAccount);
  stranger = client(strangerAccount);

  passkey = SoftwarePasskey.random();
  deadline = (await publicClient.getBlock()).timestamp + 3600n;
}, 240_000);

afterAll(async () => {
  await fork?.stop();
});

describe("digests", () => {
  it("builds the same passport digest the contract does", async () => {
    const cases: PassportInput[] = [
      input(),
      input({
        metadataURI: `ipfs://bafkreiggnfemzyzzrs6ba2ycklbfghbmpwd6mmzcy3rxhh4ovfxkfvvzsm/${"segment/".repeat(40)}image.jpg`,
      }),
      input({
        exactHash: STRIPPED_SHA256,
        parentId: ORIGINAL_SHA256,
        kind: Kind.Edited,
        generatorAgentId: 4242n,
        manifestHash: SIGNED_MANIFEST_HASH,
      }),
    ];

    for (const one of cases) {
      expect(passportDigest(one, creator.domain)).toBe(await creator.hashPassport(one));
    }
  }, 60_000);

  it("builds the same bind digest the contract does", async () => {
    const wallet = creatorAccount.address;
    const nonce = await creator.bindNonce(wallet);

    expect(bindDigest(wallet, passkey.qx, passkey.qy, nonce, creator.domain)).toBe(
      await creator.hashBind(wallet, passkey.qx, passkey.qy, nonce),
    );
  }, 60_000);
});

describe("writing passports", () => {
  it("binds a passkey and registers a Captured passport to the creator", async () => {
    const bindHash = await creator.bindPasskey(passkey);
    expect(bindHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await creator.bindNonce(creatorAccount.address)).toBe(1n);

    const captured = input();
    const auth = passkey.sign(passportDigest(captured, creator.domain));
    const { tokenId } = await creator.register(captured, auth, "0x");

    expect(tokenId).toBe(BigInt(ORIGINAL_SHA256));
    expect(await creator.ownerOf(ORIGINAL_SHA256)).toBe(creatorAccount.address);

    const record = await creator.getPassport(ORIGINAL_SHA256);
    expect(record.exactHash).toBe(ORIGINAL_SHA256);
    expect(record.creator).toBe(creatorAccount.address);
    expect(record.phash).toBe(ORIGINAL_PHASH);
    expect(record.kind).toBe(Kind.Captured);
    expect(record.generatorAgentId).toBe(0n);
    expect(record.registeredAt).toBeGreaterThan(0n);
    expect(record.disputed).toBe(false);
  }, 120_000);

  it("registers an agent on the live ERC-8004 registry and writes a Generated passport", async () => {
    const registered = await agentOwner.registerAgentOnIdentityRegistry(AGENT_CARD);
    agentId = registered.agentId;
    expect(agentId).toBeGreaterThan(0n);

    const generated = input({
      exactHash: SIGNED_SHA256,
      manifestHash: SIGNED_MANIFEST_HASH,
      kind: Kind.Generated,
      generatorAgentId: agentId,
    });
    const digest = passportDigest(generated, creator.domain);
    const auth = passkey.sign(digest);
    const generatorSig = await agentOwner.signAsGenerator(generated);
    expect(await recoverAddress({ hash: digest, signature: generatorSig })).toBe(
      agentOwnerAccount.address,
    );

    const { tokenId } = await creator.register(generated, auth, generatorSig);
    expect(tokenId).toBe(BigInt(SIGNED_SHA256));

    const record = await creator.getPassport(SIGNED_SHA256);
    expect(record.generatorAgentId).toBe(agentId);
    expect(record.kind).toBe(Kind.Generated);
    expect(record.manifestHash).toBe(SIGNED_MANIFEST_HASH);
  }, 120_000);

  it("appends an edit signed by the parent owner", async () => {
    const edit = input({
      exactHash: STRIPPED_SHA256,
      parentId: SIGNED_SHA256,
      kind: Kind.Edited,
      manifestHash: ZERO_BYTES32,
    });

    const { tokenId } = await creator.appendEdit(edit, "0x");
    expect(tokenId).toBe(BigInt(STRIPPED_SHA256));

    const record = await creator.getPassport(STRIPPED_SHA256);
    expect(record.parentId).toBe(SIGNED_SHA256);
    expect(record.kind).toBe(Kind.Edited);
    expect(await creator.ownerOf(STRIPPED_SHA256)).toBe(creatorAccount.address);
  }, 120_000);
});

describe("refusals", () => {
  const fresh = (seed: string): Hex => keccak256(toHex(seed));

  it("refuses a tampered passkey assertion", async () => {
    const one = input({ exactHash: fresh("tampered assertion") });
    const auth = passkey.sign(passportDigest(one, creator.domain));
    const swapped = auth.clientDataJSON.at(-3) === "A" ? "B" : "A";
    const tampered = {
      ...auth,
      clientDataJSON:
        auth.clientDataJSON.slice(0, -3) + swapped + auth.clientDataJSON.slice(-2),
    };

    await expect(caught(() => creator.register(one, tampered, "0x"))).resolves.toBe(
      "InvalidPasskeySignature",
    );
  }, 120_000);

  it("refuses a generator signature from the wrong wallet", async () => {
    const one = input({
      exactHash: fresh("wrong generator"),
      kind: Kind.Generated,
      generatorAgentId: agentId,
    });
    const auth = passkey.sign(passportDigest(one, creator.domain));
    const impostorSig = await stranger.signAsGenerator(one);

    await expect(caught(() => creator.register(one, auth, impostorSig))).resolves.toBe(
      "InvalidGeneratorSignature",
    );
  }, 120_000);

  it("refuses an agent id that does not exist on the ERC-8004 registry", async () => {
    const one = input({
      exactHash: fresh("unknown agent"),
      kind: Kind.Generated,
      generatorAgentId: 2n ** 200n,
    });
    const auth = passkey.sign(passportDigest(one, creator.domain));
    const signature = await agentOwner.signAsGenerator(one);

    await expect(caught(() => creator.register(one, auth, signature))).resolves.toBe(
      "UnknownAgent",
    );
  }, 120_000);

  it("refuses a passport whose deadline has passed", async () => {
    const one = input({ exactHash: fresh("expired"), deadline: 1n });
    const auth = passkey.sign(passportDigest(one, creator.domain));

    await expect(caught(() => creator.register(one, auth, "0x"))).resolves.toBe(
      "SignatureExpired",
    );
  }, 120_000);

  it("refuses a second passport for an image already registered", async () => {
    const one = input();
    const auth = passkey.sign(passportDigest(one, creator.domain));

    await expect(caught(() => creator.register(one, auth, "0x"))).resolves.toBe(
      "PassportAlreadyExists",
    );
  }, 120_000);

  it("refuses an edit from someone who does not hold the parent token", async () => {
    const one = input({
      exactHash: fresh("not the parent owner"),
      parentId: ORIGINAL_SHA256,
      kind: Kind.Edited,
      creator: strangerAccount.address,
    });

    await expect(caught(() => stranger.appendEdit(one, "0x"))).resolves.toBe("NotParentOwner");
  }, 120_000);
});

async function caught(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return creator.decodeError(error);
  }
  throw new Error("That call was supposed to be refused and was not.");
}
