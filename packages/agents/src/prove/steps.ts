import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import sharp from "sharp";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  sha256,
  type Abi,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monad } from "viem/chains";
import { z } from "zod";
import { readManifest, type ManifestSummary } from "@moolam/verifier/src/c2pa.js";
import { fingerprint, type Fingerprint } from "@moolam/verifier/src/fingerprint.js";
import { transforms, type TransformName } from "@moolam/verifier/src/transforms.js";
import { loadDeployment, MONAD_MAINNET, type Addresses } from "../chain/addresses.js";
import { registryAbi } from "../chain/artifacts.js";
import { Kind, passportDigest, type PassportInput } from "../chain/eip712.js";
import { SoftwarePasskey, type WebAuthnAuth } from "../chain/passkey.js";
import { RegistryClient } from "../chain/registry.js";
import { gatewayUrl, pinFile, pinJson } from "../ipfs/pinata.js";
import { prepareImage } from "../media/prepare.js";
import { ensureCreatorPasskey, phashHex } from "../seed/registerSeed.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, "..", "..", "..", "..");

export const EXPLORER_TX = "https://monadvision.com/tx/";
export const EXPLORER_ADDRESS = "https://monadvision.com/address/";

const CLAIM_GENERATOR = "moolam-prove/0.1.0";
const AI_SOURCE_TYPE = "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia";

export const ZERO_BYTES32 = `0x${"00".repeat(32)}` as Hex;
const FINGERPRINT_VERSION = 1;

/** One hour: long enough for four IPFS uploads, short enough that a leaked signature is stale. */
const DEADLINE_WINDOW = 3600n;

const WIDTH = 1024;
const HEIGHT = 768;
const SOURCE_QUALITY = 92;

/** A freshly pinned file takes a few seconds to appear on the public gateway. */
const GATEWAY_ATTEMPTS = 5;
const GATEWAY_PAUSE_MS = 3000;

/** The six honest journeys a picture takes after it is published, from the robustness table in proofs/robustness.txt. */
export const SURVIVAL_TRANSFORMS: TransformName[] = [
  "reencode-q60",
  "resize-25",
  "rotate-90",
  "mirror",
  "screenshot",
  "social-chain",
];

export type Signer = WalletClient<Transport, Chain, Account>;

export interface ProveContext {
  addresses: Addresses;
  publicClient: PublicClient;
  deployer: Signer;
  deployerAddress: Hex;
  registry: RegistryClient;
  registryAbi: Abi;
  say: (line?: string) => void;
}

/**
 * Builds the clients this run talks to Monad mainnet through, from the deployer key in the root
 * .env and the addresses the deploy script recorded.
 *
 * Throws when the key is missing or malformed, when there is no deployment file, or when that
 * file was written for a chain other than Monad mainnet.
 */
export function proveContext(say: (line?: string) => void): ProveContext {
  const addresses = loadDeployment();
  if (addresses.chainId !== monad.id) {
    throw new Error(
      `The deployment file is for chain ${addresses.chainId}. The prove-it run only runs against Monad mainnet (${monad.id}).`,
    );
  }

  const account = privateKeyToAccount(requiredKey("DEPLOYER_PRIVATE_KEY"));
  const transport = http(MONAD_MAINNET.rpc);
  const publicClient = createPublicClient({ chain: monad, transport }) as PublicClient;
  const deployer = createWalletClient({ account, chain: monad, transport }) as Signer;
  const registry = new RegistryClient({ publicClient, walletClient: deployer, addresses });

  return {
    addresses,
    publicClient,
    deployer,
    deployerAddress: account.address,
    registry,
    registryAbi: registryAbi(),
    say,
  };
}

/** A 32 byte hex key from the root .env, checked before anything spends gas. */
export function requiredKey(name: string): Hex {
  const value = process.env[name];
  if (value === undefined || !/^0x[0-9a-f]{64}$/i.test(value)) {
    throw new Error(`${name} is missing from the root .env, or is not a 32 byte hex key.`);
  }
  return value as Hex;
}

export interface Original {
  passportId: Hex;
  txHash: Hex;
  blockNumber: bigint;
  gasUsed: bigint;
  gasLimit: bigint;
  registeredAt: bigint;
  signed: Buffer;
  print: Fingerprint;
  manifest: ManifestSummary;
  input: PassportInput;
  creatorAuth: WebAuthnAuth;
  generatorSig: Hex;
  creatorPasskey: SoftwarePasskey;
  agentId: bigint;
  metadataUri: string;
  imageUri: string;
  thumbnailUri: string;
  metadataStatus: number;
}

/**
 * Section 1. Draws a picture nobody has registered before, signs a C2PA manifest into it, pins
 * the four files to IPFS, has the creator's passkey and the generator agent sign the same digest,
 * and registers the passport on Monad mainnet.
 *
 * The picture is drawn from a seed the caller supplies so two runs never register the same image,
 * and everything is pinned before the transaction is sent, so a failed upload costs no gas.
 *
 * Throws when the creator's passkey cannot be bound, when the image is somehow already
 * registered, when a pin fails, or when the registry refuses the write.
 */
export async function registerOriginal(
  ctx: ProveContext,
  opts: { seed: number; title: string; agentId: bigint },
): Promise<Original> {
  const passkey = SoftwarePasskey.fromPrivateKey(requiredKey("PROOF_P256_PRIVATE_KEY"));
  const bind = await ensureCreatorPasskey(
    {
      addresses: ctx.addresses,
      client: ctx.registry,
      publicClient: ctx.publicClient,
      wallet: ctx.deployerAddress,
    },
    passkey,
  );
  ctx.say(
    bind.alreadyBound
      ? `  passkey     already bound to ${ctx.deployerAddress}`
      : `  passkey     bound in ${bind.txHash}`,
  );

  const source = await sharp(drawPicture(opts.seed), {
    raw: { width: WIDTH, height: HEIGHT, channels: 3 },
  })
    .jpeg({ quality: SOURCE_QUALITY })
    .toBuffer();

  const prepared = await prepareImage(source, {
    title: opts.title,
    claimGenerator: CLAIM_GENERATOR,
    action: "c2pa.created",
    digitalSourceType: AI_SOURCE_TYPE,
  });

  const passportId = prepared.fingerprint.sha256 as Hex;
  if (await passportExists(ctx, passportId)) {
    throw new Error(`Passport ${passportId} is already on Monad. Run again for a fresh picture.`);
  }

  const slug = `moolam-prove-${passportId.slice(2, 10)}`;
  const image = await pinFile(prepared.original, `${slug}.jpg`, "image/jpeg");
  const thumbnail = await pinFile(prepared.thumbnail, `${slug}-thumb.jpg`, "image/jpeg");
  const manifestDoc = await pinJson(
    {
      manifestHash: prepared.manifestHash,
      title: prepared.manifest.title,
      claimGenerator: prepared.manifest.claimGenerator,
      actions: prepared.manifest.actions,
      softBinding:
        prepared.manifest.softBinding === undefined
          ? undefined
          : {
              alg: prepared.manifest.softBinding.alg,
              phash: phashHex(prepared.manifest.softBinding.phash),
              blockhash: prepared.manifest.softBinding.blockhash,
            },
      note: "manifestHash is the sha256 of the C2PA manifest store embedded in the image next to this document, and it is the value recorded on chain.",
    },
    `${slug}-c2pa.json`,
  );
  const metadata = await pinJson(
    {
      name: opts.title,
      description:
        "Registered by the Moolam prove-it run. The creator signed this fingerprint with a passkey and the generator agent signed the same fingerprint with the wallet that owns its ERC-8004 identity, before the registry would write the record.",
      image: image.uri,
      thumbnail: thumbnail.uri,
      manifest: manifestDoc.uri,
      generator: { agentId: opts.agentId.toString(), registry: ctx.addresses.agentIdentity },
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
    creator: ctx.deployerAddress,
    generatorAgentId: opts.agentId,
    phash: prepared.fingerprint.phash,
    blockhash256: prepared.fingerprint.blockhash as Hex,
    manifestHash: prepared.manifestHash,
    kind: Kind.Generated,
    fingerprintVersion: FINGERPRINT_VERSION,
    metadataURI: metadata.uri,
    deadline: (await ctx.publicClient.getBlock()).timestamp + DEADLINE_WINDOW,
  };

  const digest = passportDigest(input, ctx.registry.domain);
  const onChainDigest = await ctx.registry.hashPassport(input);
  if (onChainDigest.toLowerCase() !== digest.toLowerCase()) {
    throw new Error(`The passport digest here is ${digest} and the contract says ${onChainDigest}.`);
  }

  const creatorAuth = passkey.sign(digest);
  const generatorSig = await ctx.registry.signAsGenerator(input);

  let written;
  try {
    written = await ctx.registry.register(input, creatorAuth, generatorSig);
  } catch (error) {
    throw new Error(`The registry refused the passport: ${ctx.registry.decodeError(error)}`);
  }

  const receipt = await ctx.publicClient.getTransactionReceipt({ hash: written.hash });
  const sent = await ctx.publicClient.getTransaction({ hash: written.hash });
  const record = await ctx.registry.getPassport(passportId);
  const fetched = await getWithRetries(gatewayUrl(metadata.uri), "the metadata document");

  return {
    passportId,
    txHash: written.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: written.gasUsed,
    gasLimit: sent.gas,
    registeredAt: record.registeredAt,
    signed: prepared.original,
    print: prepared.fingerprint,
    manifest: prepared.manifest,
    input,
    creatorAuth,
    generatorSig,
    creatorPasskey: passkey,
    agentId: opts.agentId,
    metadataUri: metadata.uri,
    imageUri: image.uri,
    thumbnailUri: thumbnail.uri,
    metadataStatus: fetched.status,
  };
}

/**
 * Draws the picture this run registers.
 *
 * A perceptual hash needs real structure to be distinctive, so the picture gets a diagonal
 * gradient, overlapping discs, a checker patch and film grain rather than flat colour. The seed
 * decides all of it, which is what keeps two runs from ever registering the same image.
 */
export function drawPicture(seed: number): Buffer {
  const random = mulberry32(seed);
  const pixels = Buffer.alloc(WIDTH * HEIGHT * 3);

  const angle = random() * Math.PI * 2;
  const dirX = Math.cos(angle);
  const dirY = Math.sin(angle);
  const corners = [0, WIDTH * dirX, HEIGHT * dirY, WIDTH * dirX + HEIGHT * dirY];
  const low = Math.min(...corners);
  const span = Math.max(...corners) - low || 1;

  const near = [random() * 90 + 30, random() * 90 + 25, random() * 110 + 45];
  const far = [random() * 120 + 60, random() * 110 + 40, random() * 90 + 20];

  const discs = Array.from({ length: 6 }, () => ({
    x: random() * WIDTH,
    y: random() * HEIGHT,
    radius: random() * 180 + 70,
    colour: [random() * 235 + 20, random() * 235 + 20, random() * 235 + 20],
    weight: random() * 0.5 + 0.4,
  }));

  const checkerX = random() * (WIDTH - 320);
  const checkerY = random() * (HEIGHT - 320);
  const cell = 32;

  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const t = (x * dirX + y * dirY - low) / span;
      let r = (near[0] ?? 0) + ((far[0] ?? 0) - (near[0] ?? 0)) * t;
      let g = (near[1] ?? 0) + ((far[1] ?? 0) - (near[1] ?? 0)) * t;
      let b = (near[2] ?? 0) + ((far[2] ?? 0) - (near[2] ?? 0)) * t;

      for (const disc of discs) {
        const dx = x - disc.x;
        const dy = y - disc.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < disc.radius * disc.radius) {
          const falloff = (1 - d2 / (disc.radius * disc.radius)) * disc.weight;
          r += ((disc.colour[0] ?? 0) - r) * falloff;
          g += ((disc.colour[1] ?? 0) - g) * falloff;
          b += ((disc.colour[2] ?? 0) - b) * falloff;
        }
      }

      if (
        x > checkerX &&
        x < checkerX + 304 &&
        y > checkerY &&
        y < checkerY + 304 &&
        (Math.floor((x - checkerX) / cell) + Math.floor((y - checkerY) / cell)) % 2 === 0
      ) {
        r = r * 0.35 + 225;
        g = g * 0.35 + 225;
        b = b * 0.35 + 230;
      }

      const grain = (random() - 0.5) * 20;
      const offset = (y * WIDTH + x) * 3;
      pixels[offset] = clamp(r + grain);
      pixels[offset + 1] = clamp(g + grain);
      pixels[offset + 2] = clamp(b + grain);
    }
  }

  return pixels;
}

function clamp(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
}

/** Mulberry32: a small seeded generator, so one seed always draws the same picture. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface VerifyMatch {
  id: string;
  phashDistance: number;
  blockhashDistance: number;
  variant: string;
  score: number;
}

export interface VerifyAnswer {
  exact: string | null;
  best: VerifyMatch | null;
  matches: VerifyMatch[];
  confidence: number;
  manifestPresent: boolean;
}

const matchSchema = z.object({
  id: z.string(),
  phashDistance: z.number(),
  blockhashDistance: z.number(),
  variant: z.string(),
  score: z.number(),
});

const verifySchema = z.object({
  result: z.object({
    exact: z.string().nullable(),
    best: matchSchema.nullable(),
    matches: z.array(matchSchema),
    confidence: z.number(),
  }),
  manifest: z.object({ present: z.boolean() }),
});

/**
 * Posts one image to the running verify service and returns what it answered.
 *
 * Throws when the service is not listening, when it refuses the upload, or when it answers in a
 * shape this client does not know.
 */
export async function verifyFile(
  baseUrl: string,
  bytes: Buffer,
  filename: string,
): Promise<VerifyAnswer> {
  const form = new FormData();
  form.append("file", new File([new Uint8Array(bytes)], filename, { type: "image/jpeg" }));

  const response = await fetch(`${baseUrl}/verify`, { method: "POST", body: form });
  if (!response.ok) {
    throw new Error(`The verify service answered ${response.status}: ${await response.text()}`);
  }

  const parsed = verifySchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error(`The verify service answered in a shape this run does not know: ${parsed.error.message}`);
  }

  return {
    exact: parsed.data.result.exact,
    best: parsed.data.result.best,
    matches: parsed.data.result.matches,
    confidence: parsed.data.result.confidence,
    manifestPresent: parsed.data.manifest.present,
  };
}

export interface SurvivorRow {
  name: TransformName;
  bytes: number;
  variant: string;
  phashDistance: number;
  blockhashDistance: number;
  confidence: number;
  resolved: boolean;
}

/**
 * Section 2. Puts the registered image through six real journeys and asks the verify service who
 * made each copy.
 *
 * Returns one row per copy. A copy counts as resolved only when the service names the passport
 * this run registered, never merely because it named something.
 */
export async function checkSurvivors(
  original: Original,
  baseUrl: string,
  copies: Record<TransformName, Buffer>,
): Promise<SurvivorRow[]> {
  const rows: SurvivorRow[] = [];
  for (const name of SURVIVAL_TRANSFORMS) {
    const bytes = copies[name];
    const answer = await verifyFile(baseUrl, bytes, `${name}.jpg`);
    const found = answer.exact ?? answer.best?.id ?? null;
    rows.push({
      name,
      bytes: bytes.length,
      variant: answer.best?.variant ?? "none",
      phashDistance: answer.best?.phashDistance ?? -1,
      blockhashDistance: answer.best?.blockhashDistance ?? -1,
      confidence: answer.confidence,
      resolved: found !== null && found.toLowerCase() === original.passportId.toLowerCase(),
    });
  }
  return rows;
}

export interface StripResult {
  bytes: number;
  manifestBefore: boolean;
  manifestAfter: boolean;
  serviceSawManifest: boolean;
  phashDistance: number;
  blockhashDistance: number;
  confidence: number;
  resolved: boolean;
}

/**
 * Section 3. Strips every scrap of metadata out of the signed image, checks the C2PA manifest is
 * really gone, and asks the service again.
 *
 * This is the case the C2PA soft binding exists for: the manifest is what a platform throws away
 * first, and the fingerprint is what is left.
 */
export async function checkStrip(
  original: Original,
  baseUrl: string,
  stripped: Buffer,
): Promise<StripResult> {
  const before = await readManifest(original.signed);
  const after = await readManifest(stripped);
  const answer = await verifyFile(baseUrl, stripped, "strip-metadata.jpg");
  const found = answer.exact ?? answer.best?.id ?? null;

  return {
    bytes: stripped.length,
    manifestBefore: before.present,
    manifestAfter: after.present,
    serviceSawManifest: answer.manifestPresent,
    phashDistance: answer.best?.phashDistance ?? -1,
    blockhashDistance: answer.best?.blockhashDistance ?? -1,
    confidence: answer.confidence,
    resolved: found !== null && found.toLowerCase() === original.passportId.toLowerCase(),
  };
}

export interface ImpostorPassport {
  passportId: Hex;
  txHash: Hex;
  creator: Hex;
  registeredAt: bigint;
  gasUsed: bigint;
  metadataUri: string;
}

/**
 * Registers a re-encoded copy of the original as a fresh Captured original under a second
 * creator, which is what a thief would actually try after the exact duplicate is refused.
 *
 * The chain cannot stop this: the bytes are different, so it is a different image as far as a
 * hash is concerned. What answers the theft is the verify service plus the timestamps, which is
 * what the caller checks next.
 *
 * The impostor's passkey signature is the authority, so the transaction itself is paid for by
 * whoever sends it.
 */
export async function registerImpostor(
  ctx: ProveContext,
  opts: { bytes: Buffer; creator: Hex; passkey: SoftwarePasskey; title: string },
): Promise<ImpostorPassport> {
  const [qx, qy] = await passkeyOf(ctx, opts.creator);
  if (qx.toLowerCase() !== opts.passkey.qx.toLowerCase() || qy.toLowerCase() !== opts.passkey.qy.toLowerCase()) {
    throw new Error(
      `The second creator ${opts.creator} has a different passkey bound on Monad than the one on this machine. Run npm run prove:privy to rebind it.`,
    );
  }

  const print = await fingerprint(opts.bytes);
  const passportId = print.sha256 as Hex;
  if (await passportExists(ctx, passportId)) {
    throw new Error(`The re-encoded copy ${passportId} is already registered.`);
  }

  const document = Buffer.from(
    `${JSON.stringify(
      {
        name: opts.title,
        description:
          "Written by the Moolam prove-it run. This is the forgery attempt: a re-encoded copy of an image that already has a passport, claimed as an original by a second creator. It is here so the run can show what the verify service says about it.",
        image: "the re-encoded copy this passport was registered from",
        fingerprint: {
          phash: phashHex(print.phash),
          blockhash: print.blockhash,
          version: FINGERPRINT_VERSION,
        },
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const pinned = await pinFile(document, `moolam-forgery-${passportId.slice(2, 10)}.json`, "application/json");

  const input: PassportInput = {
    exactHash: passportId,
    parentId: ZERO_BYTES32,
    creator: opts.creator,
    generatorAgentId: 0n,
    phash: print.phash,
    blockhash256: print.blockhash as Hex,
    manifestHash: sha256(new Uint8Array(document)),
    kind: Kind.Captured,
    fingerprintVersion: FINGERPRINT_VERSION,
    metadataURI: pinned.uri,
    deadline: (await ctx.publicClient.getBlock()).timestamp + DEADLINE_WINDOW,
  };

  const auth = opts.passkey.sign(passportDigest(input, ctx.registry.domain));
  const written = await ctx.registry.register(input, auth, "0x");
  const record = await ctx.registry.getPassport(passportId);

  return {
    passportId,
    txHash: written.hash,
    creator: opts.creator,
    registeredAt: record.registeredAt,
    gasUsed: written.gasUsed,
    metadataUri: pinned.uri,
  };
}

export interface ChainRefusal {
  wentThrough: boolean;
  errorName: string;
  expected: string;
  txHash?: Hex;
  blockNumber?: bigint;
  gasUsed?: bigint;
  gasLimit: bigint;
  status: "reverted" | "success" | "not sent";
  refused: boolean;
  lines: string[];
}

export interface RefusalRequest {
  what: string;
  from: Signer;
  address: Hex;
  abi: Abi;
  functionName: string;
  args: unknown[];
  value?: bigint;
  gas: bigint;
  expected: string;
}

/**
 * Runs one call that is meant to be refused, twice: first as a read against the live contract so
 * the exact custom error can be decoded, then as a real transaction so the refusal is on chain
 * for anyone to open in the explorer.
 *
 * The same gas limit is used for both, so a revert can never be an out-of-gas in disguise. If the
 * read goes through, the transaction is never sent: the attack worked and the run has to say so
 * rather than quietly spend gas doing the thing it was trying to prevent.
 */
export async function refuseOnChain(
  ctx: ProveContext,
  request: RefusalRequest,
): Promise<ChainRefusal> {
  const lines: string[] = [
    `attack      ${request.what}`,
    `call        ${request.functionName} on ${request.address}`,
    `from        ${request.from.account.address}`,
    `expected    ${request.expected}`,
  ];

  let wentThrough = false;
  let errorName = "";
  try {
    await ctx.publicClient.simulateContract({
      address: request.address,
      abi: request.abi,
      functionName: request.functionName,
      args: request.args,
      account: request.from.account,
      value: request.value,
      gas: request.gas,
    });
    wentThrough = true;
    errorName = "the call went through";
  } catch (error) {
    errorName = ctx.registry.decodeError(error);
  }

  lines.push(
    wentThrough
      ? "eth_call    NOT REFUSED, the call went through against the live contract"
      : `eth_call    refused with ${errorName}, by the live contract at the same gas limit`,
  );

  if (wentThrough) {
    lines.push("sent        nothing: the run does not send a call it could not get refused");
    return {
      wentThrough,
      errorName,
      expected: request.expected,
      gasLimit: request.gas,
      status: "not sent",
      refused: false,
      lines,
    };
  }

  const data = encodeFunctionData({
    abi: request.abi,
    functionName: request.functionName,
    args: request.args,
  });

  let txHash: Hex | undefined;
  let blockNumber: bigint | undefined;
  let gasUsed: bigint | undefined;
  let status: ChainRefusal["status"] = "not sent";
  try {
    txHash = await request.from.sendTransaction({
      account: request.from.account,
      chain: request.from.chain,
      to: request.address,
      data,
      value: request.value,
      gas: request.gas,
    });
    const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash: txHash });
    blockNumber = receipt.blockNumber;
    gasUsed = receipt.gasUsed;
    status = receipt.status === "success" ? "success" : "reverted";
    lines.push(`sent        ${txHash}`);
    lines.push(`            ${EXPLORER_TX}${txHash}`);
    lines.push(
      `receipt     ${status} in block ${blockNumber}, ${gasUsed.toLocaleString("en-US")} gas used of the ${request.gas.toLocaleString("en-US")} limit set`,
    );
  } catch (error) {
    // Some nodes run the transaction before they accept it and refuse to relay one that reverts.
    // That is still a refusal, so it is recorded rather than treated as a failure of the run.
    lines.push(
      `sent        the node would not relay it: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
    );
  }

  const refused = errorName === request.expected && status !== "success";
  lines.push(`result      ${refused ? "REFUSED" : "NOT REFUSED"}`);

  return {
    wentThrough,
    errorName,
    expected: request.expected,
    txHash,
    blockNumber,
    gasUsed,
    gasLimit: request.gas,
    status,
    refused,
    lines,
  };
}

export interface VerifyService {
  baseUrl: string;
  records: number;
  stop: () => Promise<void>;
}

/**
 * Starts the verify service the way `npm run dev:verifier` does, on its own port, reading the
 * passport file this run wrote.
 *
 * The run owns the process so a judge only ever types one command, and so it can be stopped
 * again at the end. The service loads its index once at boot, which is why it is started after a
 * registration rather than before.
 *
 * Throws when something is already listening on the port, or when the service does not answer
 * its health check in time.
 */
export async function startVerifyService(opts: {
  port: number;
  passportsFile: string;
  say: (line?: string) => void;
}): Promise<VerifyService> {
  const baseUrl = `http://127.0.0.1:${opts.port}`;
  if (await answers(baseUrl)) {
    throw new Error(
      `Something is already listening on port ${opts.port}. Stop it and run again: this run starts and stops its own copy of the verify service.`,
    );
  }

  const child: ChildProcess = spawn(
    process.execPath,
    ["--import", "tsx", join("packages", "verifier", "src", "server.ts")],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        VERIFIER_PORT: String(opts.port),
        PASSPORT_SOURCE: "json",
        PASSPORT_SOURCE_PATH: opts.passportsFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const complaints: string[] = [];
  child.stderr?.on("data", (chunk: Buffer) => complaints.push(chunk.toString()));
  child.stdout?.on("data", () => undefined);

  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`The verify service stopped before it listened: ${complaints.join("").trim()}`);
    }
    const health = await healthOf(baseUrl);
    if (health !== undefined) {
      opts.say(
        `  service     started on ${baseUrl}, holding ${health.records} ${health.records === 1 ? "passport" : "passports"}`,
      );
      return {
        baseUrl,
        records: health.records,
        stop: async () => {
          child.kill();
          await new Promise<void>((resolve) => {
            if (child.exitCode !== null) return resolve();
            child.once("exit", () => resolve());
            setTimeout(() => resolve(), 5000);
          });
        },
      };
    }
    await pause(500);
  }

  child.kill();
  throw new Error(`The verify service never answered on ${baseUrl}: ${complaints.join("").trim()}`);
}

async function healthOf(baseUrl: string): Promise<{ records: number } | undefined> {
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { records?: number };
    return { records: typeof body.records === "number" ? body.records : 0 };
  } catch {
    return undefined;
  }
}

async function answers(baseUrl: string): Promise<boolean> {
  return (await healthOf(baseUrl)) !== undefined;
}

/**
 * Writes the passport file the verify service reads.
 *
 * Every field is read back off Monad rather than taken from what was sent, so this file can only
 * ever repeat what the chain says. In production the same records come from the Envio indexer.
 */
export async function writePassportIndex(
  ctx: ProveContext,
  ids: Hex[],
  file: string,
): Promise<number> {
  const records = [];
  for (const id of ids) {
    const passport = await ctx.registry.getPassport(id);
    if (passport.registeredAt === 0n) {
      throw new Error(`Passport ${id} is not on chain, so it cannot go into the verifier index.`);
    }
    records.push({
      id: id.toLowerCase(),
      phash: passport.phash.toString(),
      blockhash: passport.blockhash256.toLowerCase(),
      creator: passport.creator.toLowerCase(),
      parentId: passport.parentId === ZERO_BYTES32 ? null : passport.parentId.toLowerCase(),
      registeredAt: Number(passport.registeredAt),
      metadataURI: passport.metadataURI,
    });
  }

  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(records, null, 2)}\n`, "utf8");
  return records.length;
}

/** The fifteen transforms the verifier package measures, computed once and shared by sections. */
export async function copiesOf(bytes: Buffer): Promise<Record<TransformName, Buffer>> {
  return transforms(bytes);
}

export async function passportExists(ctx: ProveContext, id: Hex): Promise<boolean> {
  return (await ctx.publicClient.readContract({
    address: ctx.addresses.registry,
    abi: ctx.registryAbi,
    functionName: "passportExists",
    args: [id],
  })) as boolean;
}

export async function passkeyOf(ctx: ProveContext, wallet: Hex): Promise<[Hex, Hex]> {
  return (await ctx.publicClient.readContract({
    address: ctx.addresses.registry,
    abi: ctx.registryAbi,
    functionName: "getPasskey",
    args: [wallet],
  })) as [Hex, Hex];
}

export function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getWithRetries(url: string, what: string): Promise<Response> {
  let last = "";
  for (let attempt = 1; attempt <= GATEWAY_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      last = `status ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await pause(GATEWAY_PAUSE_MS);
  }
  throw new Error(`The public gateway never served ${what} at ${url}: ${last}`);
}
