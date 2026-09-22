import type { Hex } from "viem";

/** The block hash is a 16 by 16 reading of light and dark, which is what makes it drawable. */
export const SKETCH_SIDE = 16;

/** How many bits one sketch carries. */
export const SKETCH_BITS = SKETCH_SIDE * SKETCH_SIDE;

/**
 * The 256 bits of a block hash, highest first, so a grid of them reads left to
 * right and top to bottom the way the picture was measured.
 *
 * The 64 bit reader in lib/chain/fingerprint.ts takes a bigint, which is the
 * shape the perceptual hash arrives in. A block hash arrives from the registry
 * as a bytes32 word whose leading zeros are part of the picture, so it is read
 * character by character rather than through a number.
 *
 * Throws when the value is not a whole 32 byte word. A sketch drawn from a cut
 * or padded hash would be a different picture from the one on the chain, and
 * this drawing is the only thing a sealed passport shows of its picture.
 */
export function sketchBits(blockhash: Hex | string): boolean[] {
  const body = blockhash.replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(body)) {
    throw new Error("a sketch needs the whole 32 byte block hash");
  }

  return [...body].flatMap((character) => {
    const nibble = Number.parseInt(character, 16);
    return [8, 4, 2, 1].map((bit) => (nibble & bit) === bit);
  });
}
