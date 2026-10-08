// Holds the CRE workflow's pure TypeScript block hash and its eight turns and mirrors to the verify
// service's own, so the look-alike Chainlink writes cannot drift from the warning this service gives.
// Does NOT cover the workflow's chain reads, HTTP calls, consensus or report writing, does not cover
// non-JPEG thumbnails, and does not measure pictures from the web: the copies are the robustness
// corpus (24 generated pictures, 15 transforms each), the same set scripts/robustness.ts measures.

import { createRequire } from "node:module";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { blockHash, hammingHex as workflowHamming } from "../../workflow/moolam-verifier/blockhash.js";
import { decodeJpeg } from "../../workflow/moolam-verifier/decode.js";
import {
  DIHEDRAL_NAMES,
  dihedralFingerprints as workflowDihedral,
} from "../../workflow/moolam-verifier/dihedral.js";
import { LOOKALIKE_BLOCKHASH_BITS, LOOKALIKE_PHASH_BITS } from "../../workflow/moolam-verifier/lookalike-rule.js";
import { dihedralFingerprints } from "../src/dihedral.js";
import { hamming64, hammingHex } from "../src/fingerprint.js";
import { makeThumbnail } from "../src/prepare.js";
import { transforms } from "../src/transforms.js";

const require = createRequire(import.meta.url);
const imghash = require("imghash") as {
  hashRaw: (pixels: { width: number; height: number; data: Uint8Array }, bits: number) => string;
};

const CORPUS_SIZE = 24;

/**
 * The published headroom: each threshold less the worst distance between a stored fingerprint and
 * the thumbnail Chainlink fetches, measured by the service over all 39 checkable live passports
 * (kitchen/reports/fingerprint-measure-2026-10-01.md): 4 block hash bits and 3 pHash bits. A port
 * further than this from the service could push an honest copy past a threshold.
 */
const BLOCKHASH_HEADROOM = LOOKALIKE_BLOCKHASH_BITS - 4;
const PHASH_HEADROOM = LOOKALIKE_PHASH_BITS - 3;

/**
 * Measured, not chosen, over the 384 thumbnails below (each original and its 15 copies), all eight
 * variants each. On identical pixels the port is exact (the first test); everything here is the two
 * JPEG decoders, jpeg-js in the sandbox and libjpeg in sharp, which part by tens of levels on
 * single samples around sharp edges. The worst copy per thumbnail is 0 block hash bits on 135 of the 384
 * and 10 or more on 29, all of them grainy, low contrast corpus pictures whose blocks sit close to
 * their band's median. Both are floors, so a change to decode.ts, blockhash.ts, phash.ts or
 * dihedral.ts that moves the fingerprints fails here first.
 */
const MAX_BLOCKHASH_DISTANCE = 28;
const MAX_PHASH_DISTANCE = 6;

describe("the workflow's block hash against imghash", () => {
  it("is imghash's exact hash on the same pixels, at sizes that divide by 16 and sizes that do not", async () => {
    const sizes: [number, number][] = [
      [512, 384],
      [384, 512],
      [500, 333],
      [64, 48],
      [17, 31],
    ];
    for (let seed = 0; seed < 6; seed += 1) {
      for (const [width, height] of sizes) {
        const jpeg = await sharp(await generateImage(seed)).resize(width, height, { fit: "fill" }).jpeg().toBuffer();
        const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
        const rgba = new Uint8Array(info.width * info.height * 4);
        for (let i = 0; i < info.width * info.height; i += 1) {
          rgba.set([data[i * 3] as number, data[i * 3 + 1] as number, data[i * 3 + 2] as number, 255], i * 4);
        }
        const theirs = `0x${imghash.hashRaw({ width: info.width, height: info.height, data: rgba }, 16)}`;
        expect(blockHash(new Uint8Array(data), info.width, info.height, 3)).toBe(theirs);
      }
    }
  }, 60_000);

  it("reads a grey sample as three equal channels, as the canvas decoder spreads it", () => {
    const width = 40;
    const height = 24;
    const grey = new Uint8Array(width * height);
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < grey.length; i += 1) {
      grey[i] = (i * 37) % 256;
      rgba.set([grey[i] as number, grey[i] as number, grey[i] as number, 255], i * 4);
    }
    expect(blockHash(grey, width, height, 1)).toBe(`0x${imghash.hashRaw({ width, height, data: rgba }, 16)}`);
  });

  it("refuses a picture too small to fill sixteen blocks and a sample count it cannot read", () => {
    expect(() => blockHash(new Uint8Array(15 * 20 * 3), 15, 20, 3)).toThrow(/too small/);
    expect(() => blockHash(new Uint8Array(32 * 32 * 4), 32, 32, 4)).toThrow(/samples per pixel/);
  });

  it("counts differing bits like the service and refuses hashes of different lengths", () => {
    const a = `0x${"f0".repeat(32)}`;
    const b = `0x${"0f".repeat(32)}`;
    expect(workflowHamming(a, b)).toBe(hammingHex(a as `0x${string}`, b as `0x${string}`));
    expect(workflowHamming(a, a.toUpperCase().replace("0X", "0x"))).toBe(0);
    expect(() => workflowHamming(a, "0x00")).toThrow(/same length/);
  });
});

describe("the workflow's eight turns and mirrors against the service's", () => {
  it(
    `land within ${MAX_BLOCKHASH_DISTANCE} block hash bits (headroom ${BLOCKHASH_HEADROOM}) and ${MAX_PHASH_DISTANCE} pHash bits on every variant of the corpus's thumbnails`,
    async () => {
      let worstBlockhash = 0;
      let worstPhash = 0;
      let measured = 0;

      for (let seed = 0; seed < CORPUS_SIZE; seed += 1) {
        const original = await generateImage(seed);
        const copies = [original, ...Object.values(await transforms(original))];
        for (const copy of copies) {
          const thumbnail = await makeThumbnail(copy);
          const service = await dihedralFingerprints(thumbnail);
          const ours = workflowDihedral(decodeJpeg(new Uint8Array(thumbnail)));

          expect(ours.map((pair) => pair.variant)).toEqual([...DIHEDRAL_NAMES]);
          for (const pair of ours) {
            const theirs = service[pair.variant];
            worstBlockhash = Math.max(worstBlockhash, hammingHex(theirs.blockhash, pair.blockhash as `0x${string}`));
            worstPhash = Math.max(worstPhash, hamming64(theirs.phash, BigInt(pair.phash)));
            measured += 1;
          }
        }
      }

      console.log(
        `${measured} variants: worst block hash ${worstBlockhash} of 256, worst pHash ${worstPhash} of 64`,
      );
      expect(measured).toBe(CORPUS_SIZE * 16 * 8);
      expect(worstBlockhash).toBeLessThanOrEqual(MAX_BLOCKHASH_DISTANCE);
      expect(MAX_BLOCKHASH_DISTANCE).toBeLessThanOrEqual(BLOCKHASH_HEADROOM);
      expect(worstPhash).toBeLessThanOrEqual(MAX_PHASH_DISTANCE);
      expect(MAX_PHASH_DISTANCE).toBeLessThanOrEqual(PHASH_HEADROOM);
    },
    900_000,
  );
});

/** The same deterministic generator scripts/robustness.ts uses, so both measure the same corpus. */
function rng(seed: number): () => number {
  let state = (seed + 1) * 0x9e3779b9;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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
