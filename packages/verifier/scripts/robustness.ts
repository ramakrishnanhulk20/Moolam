import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { dihedralFingerprints } from "../src/dihedral.js";
import { PACKAGE_ROOT } from "../src/env.js";
import {
  BLOCKHASH_MATCH_THRESHOLD,
  PHASH_MATCH_THRESHOLD,
  fingerprint,
  hamming64,
  hammingHex,
  type Fingerprint,
} from "../src/fingerprint.js";
import { HammingIndex } from "../src/index.js";
import { transforms, type TransformName } from "../src/transforms.js";
import type { DihedralName, Hex, PassportRecord } from "../src/types.js";

const CORPUS_DIR = path.join(PACKAGE_ROOT, "corpus");
const REPORT_PATH = path.join(PACKAGE_ROOT, "..", "..", "kitchen", "reports", "WO-2-robustness.txt");
const MIN_REAL_CORPUS = 10;
const GENERATED_COUNT = 24;

const LIMITS = { phashMax: PHASH_MATCH_THRESHOLD, blockhashMax: BLOCKHASH_MATCH_THRESHOLD };

interface Row {
  transform: TransformName;
  attempts: number;
  direct: number;
  dihedral: number;
  phashSum: number;
  blockhashSum: number;
  worstPhash: number;
  worstBlockhash: number;
  falsePositives: number;
}

async function main(): Promise<void> {
  const { images, origin } = await loadCorpus();
  const prints = await Promise.all(images.map((bytes) => fingerprint(bytes)));
  const records: PassportRecord[] = prints.map((print) => ({
    id: print.sha256,
    phash: print.phash,
    blockhash: print.blockhash,
    creator: "0x0000000000000000000000000000000000000001" as Hex,
    parentId: null,
    registeredAt: 0,
    metadataURI: "",
  }));
  const index = new HammingIndex(records);

  const rows = new Map<TransformName, Row>();

  for (let i = 0; i < images.length; i += 1) {
    const original = prints[i] as Fingerprint;
    const variants = await transforms(images[i] as Buffer);

    for (const name of Object.keys(variants) as TransformName[]) {
      const row = rows.get(name) ?? {
        transform: name,
        attempts: 0,
        direct: 0,
        dihedral: 0,
        phashSum: 0,
        blockhashSum: 0,
        worstPhash: 0,
        worstBlockhash: 0,
        falsePositives: 0,
      };

      const copyPrints = await dihedralFingerprints(variants[name] as Buffer);

      // The identity entry is a lossless PNG of the same pixels, so its two
      // perceptual hashes are the ones a direct lookup would use.
      const direct = copyPrints.identity as Fingerprint;
      const directHit = index
        .query(direct.phash, direct.blockhash, LIMITS)
        .some((hit) => hit.id === original.sha256);

      const wrongIds = new Set<Hex>();
      let dihedralHit = false;
      let bestPhash = 64;
      let bestBlockhash = 256;

      for (const variant of Object.keys(copyPrints) as DihedralName[]) {
        const print = copyPrints[variant] as Fingerprint;
        const phashDistance = hamming64(original.phash, print.phash);
        const blockhashDistance = hammingHex(original.blockhash, print.blockhash);
        if (phashDistance + blockhashDistance < bestPhash + bestBlockhash) {
          bestPhash = phashDistance;
          bestBlockhash = blockhashDistance;
        }
        for (const hit of index.query(print.phash, print.blockhash, LIMITS)) {
          if (hit.id === original.sha256) {
            dihedralHit = true;
          } else {
            wrongIds.add(hit.id);
          }
        }
      }

      row.attempts += 1;
      row.direct += directHit ? 1 : 0;
      row.dihedral += dihedralHit ? 1 : 0;
      row.phashSum += bestPhash;
      row.blockhashSum += bestBlockhash;
      row.worstPhash = Math.max(row.worstPhash, bestPhash);
      row.worstBlockhash = Math.max(row.worstBlockhash, bestBlockhash);
      row.falsePositives += wrongIds.size;
      rows.set(name, row);
    }

    process.stderr.write(`  measured ${i + 1} of ${images.length} originals\n`);
  }

  const report = renderReport([...rows.values()], images.length, origin);
  console.log(report);
  await mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await writeFile(REPORT_PATH, `${report}\n`, "utf8");
}

function renderReport(rows: Row[], corpusSize: number, origin: string): string {
  const header = [
    "Moolam verifier robustness",
    "",
    `Corpus: ${origin}`,
    `Originals: ${corpusSize}. Transformed copies measured: ${corpusSize * rows.length}.`,
    `Thresholds: phash <= ${PHASH_MATCH_THRESHOLD} of 64 and blockhash <= ${BLOCKHASH_MATCH_THRESHOLD} of 256.`,
    "A match must clear both.",
    "",
    "direct match rate: the copy is fingerprinted as it arrives and looked up once.",
    "dihedral match rate: all eight rotated and mirrored variants of the copy are tried.",
    "mean phash and blockhash distance: to the copy's own original, under the closest of",
    "  the eight variants, so a rotated copy is measured after being turned back upright.",
    "false positives: distinct wrong originals returned, counted over every copy against",
    "  every other original in the corpus.",
    "",
  ];

  const columns: [string, number][] = [
    ["transform", 16],
    ["direct", 9],
    ["dihedral", 10],
    ["mean phash", 12],
    ["mean blockhash", 16],
    ["false positives", 15],
  ];
  const line = columns.map(([name, width]) => pad(name, width)).join("");
  const body = rows.map((row) =>
    [
      pad(row.transform, 16),
      pad(rate(row.direct, row.attempts), 9),
      pad(rate(row.dihedral, row.attempts), 10),
      pad((row.phashSum / row.attempts).toFixed(1), 12),
      pad((row.blockhashSum / row.attempts).toFixed(1), 16),
      pad(String(row.falsePositives), 15),
    ].join(""),
  );

  const totalFalsePositives = rows.reduce((sum, row) => sum + row.falsePositives, 0);
  const failures = rows.filter((row) => row.dihedral < row.attempts);

  return [
    ...header,
    line,
    "-".repeat(line.length),
    ...body,
    "",
    `False positives across the whole run: ${totalFalsePositives}.`,
    failures.length === 0
      ? "Every transform matched on every image."
      : "Transforms that did not match every image, with the worst single distance seen:",
    ...failures.map(
      (row) =>
        `  ${row.transform}: matched ${row.dihedral} of ${row.attempts}, ` +
        `worst phash ${row.worstPhash} of 64, worst blockhash ${row.worstBlockhash} of 256`,
    ),
  ].join("\n");
}

function rate(hits: number, attempts: number): string {
  return `${Math.round((hits / attempts) * 100)}%`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? `${value} ` : value + " ".repeat(width - value.length);
}

/**
 * Reads real images from corpus/ when there are enough of them, and otherwise
 * generates a set. A real corpus is always the better measurement; the
 * generated one exists so the numbers can be reproduced on a clean clone.
 */
async function loadCorpus(): Promise<{ images: Buffer[]; origin: string }> {
  let names: string[] = [];
  try {
    names = (await readdir(CORPUS_DIR)).filter((name) => /\.(jpe?g|png)$/i.test(name)).sort();
  } catch {
    names = [];
  }

  if (names.length >= MIN_REAL_CORPUS) {
    const images = await Promise.all(names.map((name) => readFile(path.join(CORPUS_DIR, name))));
    return { images, origin: `${names.length} real images from packages/verifier/corpus` };
  }

  const images = await Promise.all(Array.from({ length: GENERATED_COUNT }, (_unused, seed) => generateImage(seed)));
  return {
    images,
    origin:
      `${GENERATED_COUNT} generated images (corpus/ held ${names.length}, ` +
      `fewer than the ${MIN_REAL_CORPUS} needed to use it)`,
  };
}

/** A small deterministic random number generator, so the corpus is the same on every run. */
function rng(seed: number): () => number {
  let state = (seed + 1) * 0x9e3779b9;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Draws one corpus image straight into a pixel buffer.
 *
 * Each seed picks its own palette, background pattern, texture, noise level and
 * set of shapes. Variations of a single gradient would all share nearly the same
 * block hash, and a false positive count taken over such a corpus would be
 * meaningless.
 */
async function generateImage(seed: number): Promise<Buffer> {
  const random = rng(seed);
  const width = seed % 3 === 0 ? 800 : seed % 3 === 1 ? 640 : 720;
  const height = seed % 3 === 0 ? 600 : seed % 3 === 1 ? 480 : 540;
  const pixels = Buffer.alloc(width * height * 3);

  const palette: number[][] = [0, 1, 2].map(() => [random() * 255, random() * 255, random() * 255]);
  const background = seed % 4;
  const texture = Math.floor(random() * 4);
  const noise = 6 + random() * 44;
  const bandWidth = 12 + Math.floor(random() * 60);
  const [warm, cool, accent] = palette as [number[], number[], number[]];

  const shapes = Array.from({ length: 2 + Math.floor(random() * 4) }, () => ({
    x: random() * width,
    y: random() * height,
    r: 30 + random() * Math.min(width, height) * 0.28,
    kind: Math.floor(random() * 3),
    colour: [random() * 255, random() * 255, random() * 255] as const,
  }));

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const u = x / width;
      const v = y / height;
      let mix: number;
      if (background === 0) {
        mix = u;
      } else if (background === 1) {
        mix = v;
      } else if (background === 2) {
        mix = Math.hypot(u - 0.5, v - 0.5) * 1.6;
      } else {
        mix = (u + v) / 2;
      }

      let r = (warm[0] as number) * (1 - mix) + (cool[0] as number) * mix;
      let g = (warm[1] as number) * (1 - mix) + (cool[1] as number) * mix;
      let b = (warm[2] as number) * (1 - mix) + (cool[2] as number) * mix;

      if (texture === 0 && (Math.floor(x / bandWidth) + Math.floor(y / bandWidth)) % 2 === 0) {
        r = r * 0.55 + (accent[0] as number) * 0.45;
        g = g * 0.55 + (accent[1] as number) * 0.45;
        b = b * 0.55 + (accent[2] as number) * 0.45;
      } else if (texture === 1 && Math.floor(x / bandWidth) % 2 === 0) {
        r *= 0.7;
        g *= 0.7;
        b *= 0.7;
      } else if (texture === 2 && (x % bandWidth < 3 || y % bandWidth < 3)) {
        r = 245 - r * 0.3;
        g = 245 - g * 0.3;
        b = 245 - b * 0.3;
      }

      for (const shape of shapes) {
        const dx = x - shape.x;
        const dy = y - shape.y;
        const inside =
          shape.kind === 0
            ? dx * dx + dy * dy < shape.r * shape.r
            : shape.kind === 1
              ? Math.abs(dx) < shape.r && Math.abs(dy) < shape.r * 0.6
              : Math.abs(dx) + Math.abs(dy) < shape.r;
        if (inside) {
          r = shape.colour[0];
          g = shape.colour[1];
          b = shape.colour[2];
        }
      }

      const grain = (random() - 0.5) * noise;
      const offset = (y * width + x) * 3;
      pixels[offset] = clamp(r + grain);
      pixels[offset + 1] = clamp(g + grain);
      pixels[offset + 2] = clamp(b + grain);
    }
  }

  return sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
}

function clamp(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
