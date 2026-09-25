import type { Hex } from "viem";

/**
 * The 64 bit perceptual fingerprint, read the three ways the screens need it:
 * out of the word a re-check wrote, as bits, and as a distance.
 *
 * It lives here rather than beside one screen because more than one screen
 * draws the same grids off the same numbers, and a second copy of
 * this arithmetic is how the two would quietly start disagreeing.
 */

/**
 * The stored fingerprint inside the word a re-check wrote.
 *
 * The registry keeps it in a bytes32, so what comes back is a 64 bit hash with
 * forty eight hex characters of slot padding in front of it. Anything in those
 * upper bytes is not a padded fingerprint, and the whole word is read rather
 * than a silently cut one.
 */
export function phashWord(recomputed: Hex): bigint {
  const body = recomputed.replace(/^0x/, "");
  return body.length === 64 && /^0{48}/.test(body) ? BigInt(`0x${body.slice(48)}`) : BigInt(recomputed);
}

/** The 64 bits of a fingerprint, highest first, so a grid reads left to right and top to bottom. */
export function bitsOf(value: bigint): boolean[] {
  return Array.from({ length: 64 }, (_, at) => ((value >> BigInt(63 - at)) & 1n) === 1n);
}

/** How many of the 64 bits two fingerprints disagree on. */
export function bitsApart(a: bigint, b: bigint): number {
  let apart = 0;
  let left = (a ^ b) & ((1n << 64n) - 1n);
  while (left > 0n) {
    apart += Number(left & 1n);
    left >>= 1n;
  }
  return apart;
}
