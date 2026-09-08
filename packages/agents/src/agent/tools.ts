import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { monad } from "viem/chains";
import { z } from "zod";
import { loadDeployment, MONAD_MAINNET, type Addresses } from "../chain/addresses.js";
import { agentIdentityAbi, registryAbi } from "../chain/artifacts.js";
import { Kind, passportDigest, type PassportInput } from "../chain/eip712.js";
import { SoftwarePasskey } from "../chain/passkey.js";
import { RegistryClient } from "../chain/registry.js";
import { pinFile, pinJson } from "../ipfs/pinata.js";
import { prepareImage, type PreparedImage } from "../media/prepare.js";
import { ownerContext } from "../privy/client.js";
import { signPassportAsGenerator } from "../privy/generatorSigner.js";
import { readStore, sendFromWallet, type StoredWallet } from "../privy/serverWallet.js";
import { phashHex } from "../seed/registerSeed.js";
import { createImage } from "./imageModel.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, "..", "..");

/** The creator's software passkey, written by the Privy proof. Read here, never printed. */
const PASSKEY_FILE = join(PACKAGE_ROOT, ".moolam", "creator-passkey.json");

/** Where the signed JPEG the agent registered is kept, so a human can open the file it made. */
const IMAGE_DIR = join(PACKAGE_ROOT, ".moolam", "agent-images");

/**
 * The passport list the local verify service reads when PASSPORT_SOURCE is "json". Every record
 * written here is read back off Monad first, so the file is a cache of the chain and never a
 * source of its own. In production the service reads the same passports from Envio.
 */
export const PASSPORT_INDEX_FILE =
  process.env.PASSPORT_SOURCE_PATH ?? join(PACKAGE_ROOT, ".moolam", "passports.json");

const CLAIM_GENERATOR = "moolam-agent/0.1.0";
const AI_SOURCE_TYPE = "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia";
const ZERO_BYTES32 = `0x${"00".repeat(32)}` as Hex;
const EXPLORER_TX = "https://monadvision.com/tx/";
const FINGERPRINT_VERSION = 1;

/** One hour: long enough for four IPFS uploads, short enough that a stolen signature is stale. */
const DEADLINE_WINDOW = 3600n;

/** Monad charges the gas limit that was declared, so every limit is an estimate plus this. */
const GAS_MARGIN_PERCENT = 110n;

const DEFAULT_VERIFIER_BASE_URL = "http://localhost:4010";

export type ToolDefinition = ChatCompletionTool;

/** The four things this agent can do. The model picks from these and nothing else. */
export const tools: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "generate_image",
      description:
        "Draw a new picture from a prompt with the image model. Returns its size and the model that drew it.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "The full description of the picture to draw." },
        },
        required: ["prompt"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "register_passport",
      description:
        "Sign the picture you just made with a C2PA manifest, pin it to IPFS, and register its passport on Monad mainnet co-signed by this agent's ERC-8004 identity.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "A short human title for the picture." },
          prompt: { type: "string", description: "The prompt the picture was drawn from." },
        },
        required: ["title", "prompt"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "verify_image",
      description:
        "Ask the Moolam verify service who made the image the user handed over, then read that passport off Monad. Works on re-encoded and resized copies.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "lookup_agent",
      description:
        "Read an agent's owner and registration card from the ERC-8004 Identity Registry on Monad.",
      parameters: {
        type: "object",
        properties: {
          agentId: { type: "string", description: "The ERC-8004 agent id, in decimal." },
        },
        required: ["agentId"],
        additionalProperties: false,
      },
    },
  },
];

export interface GeneratedImageResult {
  bytes: Buffer;
  model: string;
  promptUsed: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

/**
 * The generate_image tool: draws the picture and hands back JPEG bytes.
 *
 * Throws when the prompt is empty, when the key is missing, or when the model returns no image.
 */
export async function generateImage(prompt: string): Promise<GeneratedImageResult> {
  const drawn = await createImage(prompt);
  return {
    bytes: drawn.bytes,
    model: drawn.model,
    promptUsed: drawn.promptUsed,
    usage: drawn.usage,
  };
}

export interface RegisteredPassport {
  passportId: Hex;
  txHash: Hex;
  metadataUri: string;
  explorerUrl: string;
  imageFile: string;
  gasLimit: bigint;
}

/**
 * The register_passport tool: everything between raw pixels and a passport on Monad mainnet.
 *
 * The picture is signed with a C2PA manifest carrying its own fingerprint, the four files are
 * pinned before any gas is spent, the creator's passkey signs the digest and this agent signs the
 * same digest inside Privy's enclave, and the transaction is sent by the agent's own server wallet
 * under a policy that allows nothing but register on this registry.
 *
 * Throws when the Privy proof has not run yet, when the creator's passkey on chain is not the one
 * on this machine, when the picture is already registered, when a pin fails, or when the registry
 * or Privy refuses the write.
 */
export async function registerPassport(
  bytes: Buffer,
  title: string,
  prompt: string,
): Promise<RegisteredPassport> {
  if (bytes.length === 0) throw new Error("There are no image bytes to register.");
  if (title.trim().length === 0) throw new Error("A passport needs a title.");
  if (prompt.trim().length === 0) {
    throw new Error("A generated passport needs the prompt it came from.");
  }

  const chain = chainContext();
  const { generator, creator, agentId } = privyWallets();
  const passkey = creatorPasskey();
  await assertPasskeyBound(chain, creator.address, passkey);

  const prepared = await prepareImage(bytes, {
    title,
    claimGenerator: CLAIM_GENERATOR,
    action: "c2pa.created",
    digitalSourceType: AI_SOURCE_TYPE,
  });

  const passportId = prepared.fingerprint.sha256 as Hex;
  if (await passportExists(chain, passportId)) {
    throw new Error(`Passport ${passportId} is already on Monad. Generate a different picture.`);
  }

  const slug = fileSlug(title, passportId);
  const image = await pinFile(prepared.original, `${slug}.jpg`, "image/jpeg");
  const thumbnail = await pinFile(prepared.thumbnail, `${slug}-thumb.jpg`, "image/jpeg");
  const manifest = await pinJson(manifestDocument(prepared), `${slug}-c2pa.json`);
  const metadata = await pinJson(
    {
      name: title,
      description:
        "An image made by the Moolam demo generator agent. The agent signed this fingerprint inside its Privy enclave with the wallet that owns its ERC-8004 identity, and the creator signed it with a passkey, before the registry would write the record.",
      image: image.uri,
      thumbnail: thumbnail.uri,
      manifest: manifest.uri,
      prompt,
      generator: { agentId: agentId.toString(), registry: chain.addresses.agentIdentity },
      fingerprint: {
        phash: phashHex(prepared.fingerprint.phash),
        blockhash: prepared.fingerprint.blockhash as Hex,
        version: FINGERPRINT_VERSION,
      },
      createdAt: new Date().toISOString(),
    },
    `${slug}.json`,
  );

  const input: PassportInput = {
    exactHash: passportId,
    parentId: ZERO_BYTES32,
    creator: creator.address,
    generatorAgentId: agentId,
    phash: prepared.fingerprint.phash,
    blockhash256: prepared.fingerprint.blockhash as Hex,
    manifestHash: prepared.manifestHash,
    kind: Kind.Generated,
    fingerprintVersion: FINGERPRINT_VERSION,
    metadataURI: metadata.uri,
    deadline: (await chain.publicClient.getBlock()).timestamp + DEADLINE_WINDOW,
  };

  const digest = passportDigest(input, chain.registry.domain);
  const onChainDigest = await chain.registry.hashPassport(input);
  if (onChainDigest.toLowerCase() !== digest.toLowerCase()) {
    throw new Error(`The passport digest here is ${digest} and the contract says ${onChainDigest}.`);
  }

  const owner = ownerContext();
  const generatorSig = await signPassportAsGenerator(
    generator.id,
    generator.address,
    input,
    chain.registry.domain,
    owner,
  );

  const data = encodeFunctionData({
    abi: registryAbi(),
    functionName: "register",
    args: [input, passkey.sign(digest), generatorSig],
  });
  const used = await chain.publicClient.estimateGas({
    account: generator.address,
    to: chain.addresses.registry,
    data,
  });
  const gasLimit = (used * GAS_MARGIN_PERCENT) / 100n;

  let txHash: Hex;
  try {
    const sent = await sendFromWallet(generator.id, {
      to: chain.addresses.registry,
      data,
      gasLimit,
      chainId: chain.addresses.chainId,
      context: owner,
    });
    txHash = sent.hash;
  } catch (error) {
    throw new Error(`The registry write was refused: ${chain.registry.decodeError(error)}`);
  }

  const receipt = await chain.publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error(`register reverted on chain in ${txHash}.`);
  }

  mkdirSync(IMAGE_DIR, { recursive: true });
  const imageFile = join(IMAGE_DIR, `${slug}.jpg`);
  writeFileSync(imageFile, prepared.original);
  await cacheForVerifier(chain, passportId, metadata.uri);

  return {
    passportId,
    txHash,
    metadataUri: metadata.uri,
    explorerUrl: `${EXPLORER_TX}${txHash}`,
    imageFile,
    gasLimit,
  };
}

export interface VerifiedImage {
  exact: Hex | null;
  best: { id: Hex; confidence: number; variant: string } | null;
  creator?: Hex;
  generatorAgentId?: string;
  registeredAt?: string;
  edits?: number;
}

const verifyResponseSchema = z.object({
  result: z.object({
    exact: z.string().nullable(),
    best: z
      .object({
        id: z.string(),
        variant: z.string(),
        phashDistance: z.number(),
        blockhashDistance: z.number(),
      })
      .nullable(),
    confidence: z.number(),
  }),
});

/**
 * The verify_image tool: asks the verify service which passport an image belongs to, then reads
 * that passport off Monad so the answer comes from the chain and not from the service.
 *
 * The service is the only thing that can match a re-encoded or rotated copy, because it holds the
 * perceptual index. The chain is the only thing that can say who signed it. Both are needed.
 *
 * Throws when the service is not running, when it refuses the upload, or when it answers in a
 * shape this client does not know.
 */
export async function verifyImage(bytes: Buffer): Promise<VerifiedImage> {
  if (bytes.length === 0) throw new Error("There are no image bytes to verify.");

  const base = (process.env.VERIFIER_BASE_URL ?? DEFAULT_VERIFIER_BASE_URL).replace(/\/$/, "");
  const form = new FormData();
  form.append("file", new File([new Uint8Array(bytes)], "query.jpg", { type: "image/jpeg" }));

  let response: Response;
  try {
    response = await fetch(`${base}/verify`, { method: "POST", body: form });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `The verify service at ${base} did not answer: ${detail}. Start it with npm run dev:verifier.`,
    );
  }
  if (!response.ok) {
    throw new Error(`The verify service refused the image: ${response.status} ${await response.text()}`);
  }

  const parsed = verifyResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error(
      `The verify service answered in a shape this client does not know: ${parsed.error.message}`,
    );
  }

  const result = parsed.data.result;
  const exact = result.exact === null ? null : (result.exact.toLowerCase() as Hex);
  const best =
    result.best === null
      ? null
      : {
          id: result.best.id.toLowerCase() as Hex,
          confidence: result.confidence,
          variant: result.best.variant,
        };

  const id = exact ?? best?.id;
  if (id === undefined) {
    return { exact, best };
  }

  const chain = chainContext();
  const passport = await chain.registry.getPassport(id);
  if (passport.registeredAt === 0n) {
    return { exact, best };
  }

  return {
    exact,
    best,
    creator: passport.creator,
    generatorAgentId: passport.generatorAgentId.toString(),
    registeredAt: new Date(Number(passport.registeredAt) * 1000).toISOString(),
    edits: Number(await childCount(chain, id)),
  };
}

export interface AgentIdentity {
  owner: Hex;
  agentURI: string;
  card?: unknown;
}

/** The slice of the ERC-8004 Identity Registry that answers "what is this agent's card". */
const agentUriAbi = [
  {
    type: "function",
    name: "tokenURI",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

/**
 * The lookup_agent tool: who owns an ERC-8004 agent and what its registration card says.
 *
 * The card is usually a data: URI holding the agent's own JSON, so it is decoded here when it is
 * one and left as a plain reference when it points somewhere else.
 *
 * Throws when the id is not a positive number, and when the registry has no such agent.
 */
export async function lookupAgent(agentId: bigint): Promise<AgentIdentity> {
  if (agentId <= 0n) throw new Error("An ERC-8004 agent id is a positive whole number.");

  const chain = chainContext();
  let owner: Hex;
  try {
    owner = getAddress(
      (await chain.publicClient.readContract({
        address: chain.addresses.agentIdentity,
        abi: agentIdentityAbi,
        functionName: "ownerOf",
        args: [agentId],
      })) as Hex,
    );
  } catch {
    throw new Error(`The ERC-8004 registry has no agent ${agentId}.`);
  }

  const agentURI = (await chain.publicClient.readContract({
    address: chain.addresses.agentIdentity,
    abi: agentUriAbi,
    functionName: "tokenURI",
    args: [agentId],
  })) as string;

  return { owner, agentURI, card: decodeCard(agentURI) };
}

interface ChainContext {
  addresses: Addresses;
  publicClient: PublicClient;
  registry: RegistryClient;
}

/**
 * The read side of Monad mainnet, plus the digest builder.
 *
 * The wallet client here carries the agent's address but no key: every write in this file is sent
 * by Privy's enclave, and nothing on this machine can sign for that wallet.
 */
function chainContext(): ChainContext {
  const addresses = loadDeployment();
  if (addresses.chainId !== monad.id) {
    throw new Error(
      `The deployment file is for chain ${addresses.chainId}. The agent runs on Monad mainnet (${monad.id}).`,
    );
  }

  const transport = http(MONAD_MAINNET.rpc);
  const publicClient = createPublicClient({ chain: monad, transport }) as PublicClient;
  const walletClient = createWalletClient({
    account: privyWallets().generator.address,
    chain: monad,
    transport,
  }) as WalletClient<Transport, Chain, Account>;

  return {
    addresses,
    publicClient,
    registry: new RegistryClient({ publicClient, walletClient, addresses }),
  };
}

/** The two Privy wallets the Privy proof created, and the agent id the generator owns. */
function privyWallets(): { generator: StoredWallet; creator: StoredWallet; agentId: bigint } {
  const store = readStore();
  const generator = store.generator;
  const creator = store.creator;
  if (!generator || !creator || !generator.agentId) {
    throw new Error(
      "No Privy wallets on this machine yet. Run npm run prove:privy once: it creates the generator wallet, its policy and its ERC-8004 identity, and the creator wallet with a passkey bound.",
    );
  }
  return { generator, creator, agentId: BigInt(generator.agentId) };
}

/** The creator's passkey from the gitignored store. The key itself never reaches a log. */
function creatorPasskey(): SoftwarePasskey {
  let raw: string;
  try {
    raw = readFileSync(PASSKEY_FILE, "utf8");
  } catch {
    throw new Error(
      `No creator passkey at ${PASSKEY_FILE}. Run npm run prove:privy once to create and bind it.`,
    );
  }
  const stored = JSON.parse(raw) as { privateKey?: string };
  if (typeof stored.privateKey !== "string") {
    throw new Error(`The passkey file at ${PASSKEY_FILE} has no privateKey field.`);
  }
  return SoftwarePasskey.fromPrivateKey(stored.privateKey as Hex);
}

/** Refuses to spend gas when the key on chain is not the key that is about to sign. */
async function assertPasskeyBound(
  chain: ChainContext,
  wallet: Hex,
  passkey: SoftwarePasskey,
): Promise<void> {
  const [qx, qy] = (await chain.publicClient.readContract({
    address: chain.addresses.registry,
    abi: registryAbi(),
    functionName: "getPasskey",
    args: [wallet],
  })) as [Hex, Hex];

  if (qx.toLowerCase() !== passkey.qx.toLowerCase() || qy.toLowerCase() !== passkey.qy.toLowerCase()) {
    throw new Error(
      `The creator wallet ${wallet} has a different passkey bound on Monad than the one on this machine. Run npm run prove:privy to rebind it.`,
    );
  }
}

async function passportExists(chain: ChainContext, id: Hex): Promise<boolean> {
  return (await chain.publicClient.readContract({
    address: chain.addresses.registry,
    abi: registryAbi(),
    functionName: "passportExists",
    args: [id],
  })) as boolean;
}

async function childCount(chain: ChainContext, id: Hex): Promise<bigint> {
  return (await chain.publicClient.readContract({
    address: chain.addresses.registry,
    abi: registryAbi(),
    functionName: "childCount",
    args: [id],
  })) as bigint;
}

/**
 * Adds the passport just written to the list the local verify service reads.
 *
 * Every field is read back off Monad rather than taken from what was sent, so a record here can
 * only ever repeat what the chain says. The service loads this file once at boot, so it has to be
 * started after a registration to see the new passport.
 */
async function cacheForVerifier(chain: ChainContext, id: Hex, metadataURI: string): Promise<void> {
  const passport = await chain.registry.getPassport(id);
  const record = {
    id: id.toLowerCase(),
    phash: passport.phash.toString(),
    blockhash: passport.blockhash256.toLowerCase(),
    creator: passport.creator.toLowerCase(),
    parentId: passport.parentId === ZERO_BYTES32 ? null : passport.parentId.toLowerCase(),
    registeredAt: Number(passport.registeredAt),
    metadataURI,
  };

  let existing: { id?: string }[] = [];
  try {
    existing = JSON.parse(readFileSync(PASSPORT_INDEX_FILE, "utf8")) as { id?: string }[];
  } catch {
    // No file yet, or one this run replaces with a readable list.
  }
  const kept = Array.isArray(existing)
    ? existing.filter((entry) => entry.id?.toLowerCase() !== record.id)
    : [];

  mkdirSync(dirname(PASSPORT_INDEX_FILE), { recursive: true });
  writeFileSync(PASSPORT_INDEX_FILE, `${JSON.stringify([...kept, record], null, 2)}\n`, "utf8");
}

/** The readable copy of the C2PA manifest pinned next to the image. */
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

/** An agent card carried inline in a data: URI, or undefined when the URI points elsewhere. */
function decodeCard(uri: string): unknown {
  const marker = "data:application/json,";
  if (!uri.startsWith(marker)) return undefined;
  try {
    return JSON.parse(decodeURIComponent(uri.slice(marker.length)));
  } catch {
    return undefined;
  }
}

function fileSlug(title: string, passportId: Hex): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${words.length === 0 ? "moolam" : words}-${passportId.slice(2, 10)}`;
}
