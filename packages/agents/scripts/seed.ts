import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { formatEther, type Hex } from "viem";
import {
  fingerprint,
  hamming64,
  PHASH_MATCH_THRESHOLD,
} from "@moolam/verifier/src/fingerprint.js";
import { DEFAULT_DEPLOYMENT_FILE } from "../src/chain/addresses.js";
import { SoftwarePasskey } from "../src/chain/passkey.js";
import { gatewayUrl } from "../src/ipfs/pinata.js";
import { THUMBNAIL_MAX_BYTES } from "../src/media/prepare.js";
import {
  ensureCreatorPasskey,
  phashHex,
  registerSeed,
  seedContext,
} from "../src/seed/registerSeed.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, "..");
const REPO_ROOT = join(PACKAGE_ROOT, "..", "..");
const STATE_FILE = join(PACKAGE_ROOT, ".moolam", "seed-state.json");
const REPORT_FILE = join(REPO_ROOT, "kitchen", "reports", "WO-5b-seed.txt");

const EXPLORER_TX = "https://monadvision.com/tx/";

const WIDTH = 1024;
const HEIGHT = 768;
const SOURCE_QUALITY = 92;

/** How long to wait for a freshly pinned file to answer on the public gateway. */
const GATEWAY_ATTEMPTS = 5;
const GATEWAY_PAUSE_MS = 3000;

interface SeedState {
  runs: number;
}

async function main(): Promise<void> {
  const run = (await readState()).runs + 1;
  const title = `Moolam seed ${run}`;
  const lines: string[] = [];
  const say = (line = "") => {
    console.log(line);
    lines.push(line);
  };

  const ctx = seedContext();
  const demoAgentId = await readDemoAgentId();
  const balance = await ctx.publicClient.getBalance({ address: ctx.wallet });

  say(`Moolam seed run ${run}, live on Monad mainnet (chain ${ctx.addresses.chainId}).`);
  say(`Started ${new Date().toISOString()}`);
  say(`Registry ${ctx.addresses.registry}`);
  say(`Wallet   ${ctx.wallet}, ${Number(formatEther(balance)).toFixed(3)} MON`);
  say(`Agent    ${demoAgentId} on the ERC-8004 registry at ${ctx.addresses.agentIdentity}`);

  const passkey = SoftwarePasskey.fromPrivateKey(proofKey());
  const bind = await ensureCreatorPasskey(ctx, passkey);
  say(
    bind.alreadyBound
      ? "Passkey  already bound to this wallet, no bind transaction needed."
      : `Passkey  bound in ${bind.txHash}  ${EXPLORER_TX}${bind.txHash}`,
  );
  say();

  const source = await sharp(drawSeedImage(run), {
    raw: { width: WIDTH, height: HEIGHT, channels: 3 },
  })
    .jpeg({ quality: SOURCE_QUALITY })
    .toBuffer();
  say(`Source picture: ${WIDTH} by ${HEIGHT}, ${source.length.toLocaleString("en-US")} bytes, drawn from seed ${run}.`);

  const seeded = await registerSeed({
    source,
    title,
    kind: "generated",
    creatorPasskey: passkey,
    generatorAgentId: demoAgentId,
  });

  const metadata = await fetchMetadata(seeded.metadataUri);
  say();
  say("Files on IPFS");
  for (const [label, uri] of [
    ["image    ", metadata.image],
    ["thumbnail", seeded.thumbnailUri],
    ["manifest ", metadata.manifest],
    ["metadata ", seeded.metadataUri],
  ] as const) {
    say(`  ${label}  ${uri}`);
    say(`             ${gatewayUrl(uri)}`);
  }

  const record = await ctx.client.getPassport(seeded.passportId);
  const receipt = await ctx.publicClient.getTransactionReceipt({ hash: seeded.txHash });
  const sent = await ctx.publicClient.getTransaction({ hash: seeded.txHash });
  const billed = sent.gas * receipt.effectiveGasPrice;

  say();
  say("On chain");
  say(`  passport id  ${seeded.passportId}`);
  say(`  transaction  ${seeded.txHash}`);
  say(`               ${EXPLORER_TX}${seeded.txHash}`);
  say(`  block        ${receipt.blockNumber.toLocaleString("en-US")}`);
  say(`  owner        ${await ctx.client.ownerOf(seeded.passportId)}`);
  say(`  agent        ${record.generatorAgentId}, kind ${record.kind === 0 ? "Generated" : "Captured"}`);
  say(`  phash        ${phashHex(record.phash)}`);
  say(`  manifest     ${record.manifestHash}`);
  say(`  metadataURI  ${record.metadataURI}`);
  say(
    `  gas          ${seeded.gasUsed.toLocaleString("en-US")} used of a ${sent.gas.toLocaleString("en-US")} limit, ` +
      `and Monad bills the limit: ${Number(formatEther(billed)).toFixed(4)} MON`,
  );

  const checked = await checkThumbnail(seeded.thumbnailUri, record.phash);
  say();
  say("Thumbnail, fetched back through the public gateway the verifier uses");
  say(`  GET ${checked.url}`);
  say(`  status ${checked.status}, content-type ${checked.contentType}, ${checked.size.toLocaleString("en-US")} bytes`);
  say(`  size cap for the Chainlink fetch is ${THUMBNAIL_MAX_BYTES.toLocaleString("en-US")} bytes: ${checked.size <= THUMBNAIL_MAX_BYTES ? "under" : "OVER"}`);
  say(`  registered phash ${phashHex(record.phash)}`);
  say(`  refetched  phash ${phashHex(checked.phash)}`);
  say(`  distance ${checked.distance} of 64 bits, threshold ${PHASH_MATCH_THRESHOLD}: ${checked.distance <= PHASH_MATCH_THRESHOLD ? "match" : "NO MATCH"}`);

  if (checked.status !== 200 || !checked.contentType.startsWith("image/jpeg")) {
    throw new Error(`The gateway answered ${checked.status} ${checked.contentType} for the thumbnail.`);
  }
  if (checked.size > THUMBNAIL_MAX_BYTES) {
    throw new Error(`The thumbnail is ${checked.size} bytes, over the ${THUMBNAIL_MAX_BYTES} byte cap.`);
  }
  if (checked.distance > PHASH_MATCH_THRESHOLD) {
    throw new Error(`The refetched thumbnail is ${checked.distance} bits away from the registered fingerprint.`);
  }

  await writeState({ runs: run });
  await appendReport(lines);
  say();
  console.log(`Saved to ${REPORT_FILE}`);
}

/**
 * Draws the picture this run registers.
 *
 * Every seed gives a different arrangement of gradient, discs, bands and grain. Flat colour would
 * make one perceptual hash look like every other, so the picture needs real structure, and the
 * grain keeps two runs from ever landing on the same fingerprint.
 */
function drawSeedImage(seed: number): Buffer {
  const random = mulberry32(seed * 2654435761);
  const pixels = Buffer.alloc(WIDTH * HEIGHT * 3);

  const angle = random() * Math.PI * 2;
  const dirX = Math.cos(angle);
  const dirY = Math.sin(angle);
  const projections = [
    0,
    WIDTH * dirX,
    HEIGHT * dirY,
    WIDTH * dirX + HEIGHT * dirY,
  ];
  const low = Math.min(...projections);
  const span = Math.max(...projections) - low || 1;

  const near: [number, number, number] = [random() * 90 + 30, random() * 90 + 25, random() * 110 + 45];
  const far: [number, number, number] = [random() * 120 + 60, random() * 110 + 40, random() * 90 + 20];

  const discs = Array.from({ length: 5 }, () => ({
    x: random() * WIDTH,
    y: random() * HEIGHT,
    radius: random() * 170 + 80,
    colour: [random() * 235 + 20, random() * 235 + 20, random() * 235 + 20] as [number, number, number],
    weight: random() * 0.5 + 0.4,
  }));

  const bands = Array.from({ length: 2 }, () => ({
    offset: random() * (WIDTH + HEIGHT),
    half: random() * 22 + 14,
  }));

  const checkerX = random() * (WIDTH - 300);
  const checkerY = random() * (HEIGHT - 300);
  const cell = 32;

  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const t = (x * dirX + y * dirY - low) / span;
      let r = near[0] + (far[0] - near[0]) * t;
      let g = near[1] + (far[1] - near[1]) * t;
      let b = near[2] + (far[2] - near[2]) * t;

      for (const disc of discs) {
        const dx = x - disc.x;
        const dy = y - disc.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < disc.radius * disc.radius) {
          const falloff = (1 - d2 / (disc.radius * disc.radius)) * disc.weight;
          r += (disc.colour[0] - r) * falloff;
          g += (disc.colour[1] - g) * falloff;
          b += (disc.colour[2] - b) * falloff;
        }
      }

      for (const band of bands) {
        if (Math.abs(x * 0.6 + y * 0.8 - band.offset) < band.half) {
          r *= 0.18;
          g *= 0.2;
          b *= 0.26;
        }
      }

      if (
        x > checkerX &&
        x < checkerX + 288 &&
        y > checkerY &&
        y < checkerY + 288 &&
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

/** Mulberry32: a small seeded generator, so run 3 always draws the same picture. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function checkThumbnail(
  uri: string,
  registeredPhash: bigint,
): Promise<{ url: string; status: number; contentType: string; size: number; phash: bigint; distance: number }> {
  const url = gatewayUrl(uri);
  const response = await getWithRetries(url, "thumbnail");
  const bytes = Buffer.from(await response.arrayBuffer());
  const print = await fingerprint(bytes);

  return {
    url,
    status: response.status,
    contentType: response.headers.get("content-type") ?? "none",
    size: bytes.length,
    phash: print.phash,
    distance: hamming64(print.phash, registeredPhash),
  };
}

async function fetchMetadata(uri: string): Promise<{ image: string; manifest: string }> {
  const response = await getWithRetries(gatewayUrl(uri), "metadata");
  const parsed = (await response.json()) as { image?: string; manifest?: string };
  if (typeof parsed.image !== "string" || typeof parsed.manifest !== "string") {
    throw new Error(`The metadata at ${uri} is missing the image or manifest link.`);
  }
  return { image: parsed.image, manifest: parsed.manifest };
}

/**
 * A freshly pinned file can take a few seconds to answer on the public gateway, so a 404 or a
 * gateway error is retried before the run is called a failure.
 */
async function getWithRetries(url: string, what: string): Promise<Response> {
  let last = "";
  for (let attempt = 1; attempt <= GATEWAY_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return response;
      }
      last = `status ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, GATEWAY_PAUSE_MS));
  }
  throw new Error(`The gateway never served the ${what} at ${url}: ${last}`);
}

async function readDemoAgentId(): Promise<bigint> {
  const parsed = JSON.parse(await readFile(DEFAULT_DEPLOYMENT_FILE, "utf8")) as { demoAgentId?: number };
  if (typeof parsed.demoAgentId !== "number") {
    throw new Error(`The deployment file at ${DEFAULT_DEPLOYMENT_FILE} has no demoAgentId.`);
  }
  return BigInt(parsed.demoAgentId);
}

async function readState(): Promise<SeedState> {
  try {
    const parsed = JSON.parse(await readFile(STATE_FILE, "utf8")) as { runs?: number };
    return { runs: typeof parsed.runs === "number" ? parsed.runs : 0 };
  } catch {
    return { runs: 0 };
  }
}

async function writeState(state: SeedState): Promise<void> {
  await mkdir(dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/** Each run appends, so the report holds every seed passport rather than only the last one. */
async function appendReport(lines: string[]): Promise<void> {
  let existing = "";
  try {
    existing = await readFile(REPORT_FILE, "utf8");
  } catch {
    existing = "";
  }
  const separator = existing.length === 0 ? "" : "\n\n";
  await writeFile(REPORT_FILE, `${existing}${separator}${lines.join("\n")}\n`, "utf8");
}

function proofKey(): Hex {
  const key = process.env.PROOF_P256_PRIVATE_KEY;
  if (key === undefined || !/^0x[0-9a-f]{64}$/i.test(key)) {
    throw new Error("PROOF_P256_PRIVATE_KEY is missing from the root .env, or is not a 32 byte hex key.");
  }
  return key as Hex;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
