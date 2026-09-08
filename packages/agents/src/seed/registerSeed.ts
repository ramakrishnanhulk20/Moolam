import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monad } from "viem/chains";
import { z } from "zod";
import { loadDeployment, MONAD_MAINNET, type Addresses } from "../chain/addresses.js";
import { Kind, passportDigest, type PassportInput } from "../chain/eip712.js";
import type { SoftwarePasskey } from "../chain/passkey.js";
import { RegistryClient } from "../chain/registry.js";
import { pinFile, pinJson } from "../ipfs/pinata.js";
import { prepareImage, type PreparedImage } from "../media/prepare.js";

const CLAIM_GENERATOR = "moolam-seed/0.1.0";

/** IPTC digital source types: what made the picture. C2PA readers key their labels off these. */
const AI_SOURCE_TYPE = "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia";
const CAPTURE_SOURCE_TYPE = "http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture";

const ZERO_BYTES32 = `0x${"00".repeat(32)}` as Hex;

/**
 * How long the two signatures stay valid. One hour is long enough for a slow upload and short
 * enough that a leaked signature is worthless by the time anyone finds it.
 */
const DEADLINE_WINDOW = 3600n;

const FINGERPRINT_VERSION = 1;

const registryViewAbi = parseAbi([
  "function getPasskey(address wallet) view returns (bytes32 qx, bytes32 qy)",
  "function passportExists(bytes32 id) view returns (bool)",
]);

export interface SeedMetadata {
  name: string;
  description: string;
  image: string;
  thumbnail: string;
  manifest: string;
  generator: { agentId: string; registry: Hex };
  fingerprint: { phash: string; blockhash: Hex; version: 1 };
  createdAt: string;
}

export interface SeedContext {
  addresses: Addresses;
  client: RegistryClient;
  publicClient: PublicClient;
  wallet: Hex;
}

export interface SeedResult {
  passportId: Hex;
  txHash: Hex;
  metadataUri: string;
  thumbnailUri: string;
  gasUsed: bigint;
}

/**
 * Builds the clients the seed talks to Monad mainnet through, from the deployer key in the root
 * .env and the addresses the deploy script recorded.
 *
 * Throws when the key is missing or malformed, when no deployment file exists, or when that file
 * was written for another chain.
 */
export function seedContext(): SeedContext {
  const addresses = loadDeployment();
  if (addresses.chainId !== monad.id) {
    throw new Error(
      `The deployment file is for chain ${addresses.chainId}, and the seed only runs against Monad mainnet (${monad.id}).`,
    );
  }

  const account = privateKeyToAccount(deployerKey());
  const transport = http(MONAD_MAINNET.rpc);
  const publicClient = createPublicClient({ chain: monad, transport }) as PublicClient;
  const walletClient = createWalletClient({ account, chain: monad, transport });

  return {
    addresses,
    client: new RegistryClient({ publicClient, walletClient, addresses }),
    publicClient,
    wallet: account.address,
  };
}

/**
 * Makes sure the seed wallet has this exact passkey bound on the live registry, binding it when
 * nothing is bound or when a different key is.
 *
 * Returns the bind transaction hash when one was sent, so the caller can print it.
 */
export async function ensureCreatorPasskey(
  ctx: SeedContext,
  passkey: SoftwarePasskey,
): Promise<{ alreadyBound: boolean; txHash?: Hex }> {
  const [qx, qy] = (await ctx.publicClient.readContract({
    address: ctx.addresses.registry,
    abi: registryViewAbi,
    functionName: "getPasskey",
    args: [ctx.wallet],
  })) as [Hex, Hex];

  if (qx.toLowerCase() === passkey.qx.toLowerCase() && qy.toLowerCase() === passkey.qy.toLowerCase()) {
    return { alreadyBound: true };
  }

  return { alreadyBound: false, txHash: await ctx.client.bindPasskey(passkey) };
}

export interface RegisterSeedOptions {
  source: Buffer;
  title: string;
  kind: "generated" | "captured";
  creatorPasskey: SoftwarePasskey;
  generatorAgentId?: bigint;
}

/**
 * Puts one passport on Monad mainnet with its files on IPFS: the C2PA signed image, a thumbnail
 * the Chainlink verifier can fetch, a readable copy of the manifest, and the metadata document
 * the passport points at.
 *
 * Everything is pinned before the transaction is sent, so a failed upload costs no gas, and the
 * passport is checked for existence first, so a repeat run reports the clash instead of paying
 * for a revert.
 *
 * Throws when a Generated passport has no agent id, when a Captured one carries one, when the
 * image is already registered, when a pin fails, or when the registry refuses the write.
 */
export async function registerSeed(opts: RegisterSeedOptions): Promise<SeedResult> {
  const generated = opts.kind === "generated";
  const agentId = generated ? (opts.generatorAgentId ?? 0n) : 0n;
  if (generated && agentId === 0n) {
    throw new Error("A Generated passport needs the ERC-8004 agent id whose owner co-signs it.");
  }
  if (!generated && opts.generatorAgentId !== undefined) {
    throw new Error("A Captured passport carries no agent id, so leave generatorAgentId out.");
  }
  if (opts.title.length === 0) {
    throw new Error("A passport needs a title.");
  }

  const ctx = seedContext();
  const prepared = await prepareImage(opts.source, {
    title: opts.title,
    claimGenerator: CLAIM_GENERATOR,
    action: "c2pa.created",
    digitalSourceType: generated ? AI_SOURCE_TYPE : CAPTURE_SOURCE_TYPE,
  });

  const passportId = prepared.fingerprint.sha256 as Hex;
  const exists = (await ctx.publicClient.readContract({
    address: ctx.addresses.registry,
    abi: registryViewAbi,
    functionName: "passportExists",
    args: [passportId],
  })) as boolean;
  if (exists) {
    throw new Error(`Passport ${passportId} is already on chain. Seed a different picture.`);
  }

  const slug = fileSlug(opts.title, passportId);
  const image = await pinFile(prepared.original, `${slug}.jpg`, "image/jpeg");
  const thumbnail = await pinFile(prepared.thumbnail, `${slug}-thumb.jpg`, "image/jpeg");
  const manifest = await pinJson(manifestDocument(prepared), `${slug}-c2pa.json`);

  const metadata: SeedMetadata = {
    name: opts.title,
    description: generated
      ? "An image made by the Moolam demo generator agent. The agent signed this fingerprint with the wallet that owns its ERC-8004 identity, and the creator signed it with a passkey, before the registry would write the record."
      : "A photograph registered with Moolam. The creator signed this fingerprint with a passkey before the registry would write the record.",
    image: image.uri,
    thumbnail: thumbnail.uri,
    manifest: manifest.uri,
    generator: { agentId: agentId.toString(), registry: ctx.addresses.agentIdentity },
    fingerprint: {
      phash: phashHex(prepared.fingerprint.phash),
      blockhash: prepared.fingerprint.blockhash as Hex,
      version: FINGERPRINT_VERSION,
    },
    createdAt: new Date().toISOString(),
  };
  const metadataPin = await pinJson(metadata, `${slug}.json`);

  const deadline = (await ctx.publicClient.getBlock()).timestamp + DEADLINE_WINDOW;
  const input: PassportInput = {
    exactHash: passportId,
    parentId: ZERO_BYTES32,
    creator: ctx.wallet,
    generatorAgentId: agentId,
    phash: prepared.fingerprint.phash,
    blockhash256: prepared.fingerprint.blockhash as Hex,
    manifestHash: prepared.manifestHash,
    kind: generated ? Kind.Generated : Kind.Captured,
    fingerprintVersion: FINGERPRINT_VERSION,
    metadataURI: metadataPin.uri,
    deadline,
  };

  const digest = passportDigest(input, ctx.client.domain);
  const creatorAuth = opts.creatorPasskey.sign(digest);
  const generatorSig = generated ? await ctx.client.signAsGenerator(input) : "0x";

  try {
    const written = await ctx.client.register(input, creatorAuth, generatorSig);
    return {
      passportId,
      txHash: written.hash,
      metadataUri: metadataPin.uri,
      thumbnailUri: thumbnail.uri,
      gasUsed: written.gasUsed,
    };
  } catch (error) {
    throw new Error(`The registry refused this passport: ${ctx.client.decodeError(error)}`);
  }
}

/** The 64 bit perceptual hash as it reads in the metadata and in the logs. */
export function phashHex(phash: bigint): string {
  return `0x${phash.toString(16).padStart(16, "0")}`;
}

/**
 * The readable copy of the C2PA manifest that gets pinned next to the image.
 *
 * The signed image itself carries the real manifest store; this document is the summary plus the
 * sha256 the chain commits to, so anyone can line the two up without a C2PA reader.
 */
function manifestDocument(prepared: PreparedImage): unknown {
  const binding = prepared.manifest.softBinding;
  return {
    manifestHash: prepared.manifestHash,
    title: prepared.manifest.title,
    claimGenerator: prepared.manifest.claimGenerator,
    actions: prepared.manifest.actions,
    ingredients: prepared.manifest.ingredients,
    softBinding:
      binding === undefined
        ? undefined
        : { alg: binding.alg, phash: phashHex(binding.phash), blockhash: binding.blockhash },
    note: "manifestHash is the sha256 of the C2PA manifest store embedded in the image this document sits next to, and it is the value recorded on chain.",
  };
}

function fileSlug(title: string, passportId: Hex): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${words.length === 0 ? "moolam" : words}-${passportId.slice(2, 10)}`;
}

function deployerKey(): Hex {
  const parsed = z
    .string()
    .regex(/^0x[0-9a-f]{64}$/i)
    .safeParse(process.env.DEPLOYER_PRIVATE_KEY);
  if (!parsed.success) {
    throw new Error("DEPLOYER_PRIVATE_KEY is missing from the root .env, or is not a 32 byte hex key.");
  }
  return parsed.data as Hex;
}
