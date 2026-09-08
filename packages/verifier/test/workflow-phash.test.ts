// Pins the CRE workflow's pure TypeScript fingerprint to the verifier's sharp based one, so an
// on-chain verdict cannot drift away from what the API would say about the same picture.
// Does NOT cover the workflow's chain reads, HTTP fetches, consensus or report writing, does not
// cover non-JPEG input, and measures untransformed images only: how the hash holds up under
// re-encodes, crops and rotations is what scripts/robustness.ts measures.

import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { decodeJpeg } from "../../workflow/moolam-verifier/decode.js";
import { perceptualHash } from "../../workflow/moolam-verifier/phash.js";
import { fingerprint, hamming64 } from "../src/fingerprint.js";

const CORPUS_SIZE = 24;

/**
 * Measured, not chosen. Over the 24 generated corpus images the workflow's hash is 0 bits from
 * sharp-phash on 11 of them and never more than 2 bits away, against the match threshold of 10
 * the chain uses. These images carry heavy grain, which is what leaves a coefficient near the
 * block average free to tip either way; the verifier's own smoother test images land exactly.
 * Both numbers are floors: if a change to decode.ts or phash.ts moves the fingerprint, this test
 * fails before the verdict on chain can drift away from the API's answer.
 */
const MAX_DISTANCE = 2;
const MIN_EXACT = 11;

const SAMPLE_SIZE = 32;
const LOW_SIZE = 8;

describe("the workflow fingerprint against sharp-phash", () => {
  it(
    `lands within ${MAX_DISTANCE} bits on all ${CORPUS_SIZE} corpus images and exactly on at least ${MIN_EXACT}`,
    async () => {
      const distances: number[] = [];

      for (let seed = 0; seed < CORPUS_SIZE; seed += 1) {
        const bytes = await generateImage(seed);
        const print = await fingerprint(bytes);
        const image = decodeJpeg(new Uint8Array(bytes));
        const recomputed = perceptualHash(image.pixels, image.width, image.height, image.channels);

        expect(image.channels).toBe(3);
        distances.push(hamming64(print.phash, recomputed));
      }

      const worst = Math.max(...distances);
      const exact = distances.filter((distance) => distance === 0).length;

      console.log(`worst ${worst} bits of 64, exact on ${exact} of ${CORPUS_SIZE}`);
      expect(worst).toBeLessThanOrEqual(MAX_DISTANCE);
      expect(exact).toBeGreaterThanOrEqual(MIN_EXACT);
    },
    180_000,
  );
});

describe("the separable DCT", () => {
  it("gives the same 64 bits as the direct four-loop DCT on ten random grids", () => {
    const random = rng(7);

    for (let round = 0; round < 10; round += 1) {
      const pixels = new Uint8Array(SAMPLE_SIZE * SAMPLE_SIZE);
      for (let i = 0; i < pixels.length; i += 1) {
        pixels[i] = Math.floor(random() * 256);
      }

      expect(perceptualHash(pixels, SAMPLE_SIZE, SAMPLE_SIZE, 1)).toBe(directHash(pixels));
    }
  });
});

describe("the workflow fingerprint's channel guard", () => {
  it("refuses a sample count it cannot read", () => {
    const pixels = new Uint8Array(SAMPLE_SIZE * SAMPLE_SIZE * 4);
    expect(() => perceptualHash(pixels, SAMPLE_SIZE, SAMPLE_SIZE, 4)).toThrow(/samples per pixel/);
  });
});

/**
 * The fingerprint as phash.ts computed it before the DCT was made separable: one sum over both
 * axes for every output coefficient. Kept here as the oracle the faster version has to match.
 */
function directHash(pixels: Uint8Array): bigint {
  const cos: number[][] = [];
  for (let k = 0; k < SAMPLE_SIZE; k += 1) {
    const row: number[] = [];
    for (let n = 0; n < SAMPLE_SIZE; n += 1) {
      row.push(Math.cos(((2 * k + 1) / (2 * SAMPLE_SIZE)) * n * Math.PI));
    }
    cos.push(row);
  }
  const sqrt: number[] = [];
  for (let i = 0; i < SAMPLE_SIZE; i += 1) sqrt.push(i === 0 ? 1 / Math.sqrt(2) : 1);

  const signal: number[][] = [];
  for (let x = 0; x < SAMPLE_SIZE; x += 1) {
    const column: number[] = [];
    for (let y = 0; y < SAMPLE_SIZE; y += 1) column.push(pixels[SAMPLE_SIZE * y + x] as number);
    signal.push(column);
  }

  const dct: number[][] = [];
  for (let u = 0; u < SAMPLE_SIZE; u += 1) {
    const row: number[] = [];
    for (let v = 0; v < SAMPLE_SIZE; v += 1) {
      let sum = 0;
      for (let i = 0; i < SAMPLE_SIZE; i += 1) {
        for (let j = 0; j < SAMPLE_SIZE; j += 1) {
          sum += (cos[i] as number[])[u]! * (cos[j] as number[])[v]! * (signal[i] as number[])[j]!;
        }
      }
      row.push((sum * (sqrt[u] as number) * (sqrt[v] as number)) / 4);
    }
    dct.push(row);
  }

  let total = 0;
  for (let x = 0; x < LOW_SIZE; x += 1) {
    for (let y = 0; y < LOW_SIZE; y += 1) total += (dct[x + 1] as number[])[y + 1]!;
  }
  const average = total / (LOW_SIZE * LOW_SIZE);

  let hash = 0n;
  for (let x = 0; x < LOW_SIZE; x += 1) {
    for (let y = 0; y < LOW_SIZE; y += 1) {
      hash = (hash << 1n) | ((dct[x + 1] as number[])[y + 1]! > average ? 1n : 0n);
    }
  }
  return hash;
}

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
