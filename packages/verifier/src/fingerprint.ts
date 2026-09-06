import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import sharp from "sharp";

const require = createRequire(import.meta.url);

// sharp-phash and imghash ship no type declarations, so they are loaded through
// require and given the exact shapes their READMEs document.
const sharpPhash = require("sharp-phash") as (input: Buffer) => Promise<string>;
const imghash = require("imghash") as {
  hash: (input: Buffer | string, bits?: number, format?: "hex" | "binary") => Promise<string>;
};

export type Hex = `0x${string}`;

export interface Fingerprint {
  sha256: Hex;
  phash: bigint;
  blockhash: Hex;
  width: number;
  height: number;
  format: string;
}

/**
 * Bits per row handed to imghash. 16 gives a 16x16 grid, so a 256-bit hash in
 * 64 hex characters. More rows means more spatial detail, which is what makes
 * this hash react to crops that the 64-bit pHash shrugs off.
 */
const BLOCKHASH_BITS_PER_ROW = 16;

const PHASH_BITS = 64;
const BLOCKHASH_BITS = BLOCKHASH_BITS_PER_ROW * BLOCKHASH_BITS_PER_ROW;

/**
 * Two images count as the same picture when their pHashes differ by at most
 * this many of 64 bits. Measured by scripts/spike.ts: re-encoding to quality
 * 60, halving the size, quartering the size and stripping metadata all came
 * back at 0 bits, and a 20 percent brightness lift at 3 bits, so 10 leaves
 * headroom over the worst honest case. Cropping 10 percent (21 bits), rotating
 * 90 degrees (31 bits) and mirroring (29 bits) sit above it and are not caught
 * by this hash: those need the rotated and mirrored variants fingerprinted at
 * registration time instead.
 */
export const PHASH_MATCH_THRESHOLD = 10;

/**
 * Same idea for the 256-bit blockhash. The spike measured the same honest
 * transforms at 0 bits, and the brightness lift at 10 bits, so 40 is roughly
 * four times the worst honest case and still far below the 74 bits a 10 percent
 * crop produced or the 128 bits a random pair averages.
 */
export const BLOCKHASH_MATCH_THRESHOLD = 40;

/**
 * Computes the three fingerprints Moolam stores for an image: the exact-bytes
 * sha256, a 64-bit pHash and a 256-bit blockhash, plus the pixel dimensions and
 * container format.
 *
 * Throws when the buffer is empty or is not an image sharp can decode.
 */
export async function fingerprint(bytes: Buffer): Promise<Fingerprint> {
  if (bytes.length === 0) {
    throw new Error("fingerprint needs a non-empty image buffer");
  }

  const metadata = await sharp(bytes).metadata();
  const [phashBits, blockhashHex] = await Promise.all([
    sharpPhash(bytes),
    imghash.hash(bytes, BLOCKHASH_BITS_PER_ROW, "hex"),
  ]);

  if (phashBits.length !== PHASH_BITS) {
    throw new Error(`expected a ${PHASH_BITS} bit pHash, got ${phashBits.length} bits`);
  }
  if (blockhashHex.length !== BLOCKHASH_BITS / 4) {
    throw new Error(`expected a ${BLOCKHASH_BITS} bit blockhash, got ${blockhashHex.length * 4} bits`);
  }

  return {
    sha256: `0x${createHash("sha256").update(bytes).digest("hex")}`,
    phash: BigInt(`0b${phashBits}`),
    blockhash: `0x${blockhashHex}`,
    width: metadata.width ?? 0,
    height: metadata.height ?? 0,
    format: metadata.format ?? "unknown",
  };
}

/** Counts the differing bits between two 64-bit pHashes. */
export function hamming64(a: bigint, b: bigint): number {
  const mask = (1n << 64n) - 1n;
  let diff = (a ^ b) & mask;
  let bits = 0;
  while (diff !== 0n) {
    diff &= diff - 1n;
    bits += 1;
  }
  return bits;
}

/** Counts the differing bits between two hex hashes of the same length. */
export function hammingHex(a: Hex, b: Hex): number {
  const left = a.slice(2).toLowerCase();
  const right = b.slice(2).toLowerCase();
  if (left.length !== right.length) {
    throw new Error(`hammingHex needs equal length hashes, got ${left.length} and ${right.length}`);
  }

  let bits = 0;
  for (let i = 0; i < left.length; i += 1) {
    const l = Number.parseInt(left[i] ?? "", 16);
    const r = Number.parseInt(right[i] ?? "", 16);
    if (Number.isNaN(l) || Number.isNaN(r)) {
      throw new Error("hammingHex needs hex strings prefixed with 0x");
    }
    let nibble = l ^ r;
    while (nibble !== 0) {
      nibble &= nibble - 1;
      bits += 1;
    }
  }
  return bits;
}
