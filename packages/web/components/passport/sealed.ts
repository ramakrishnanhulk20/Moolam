import { sketchBits } from "@/components/sealed/bits";

/**
 * The bits a sealed record is drawn from, taken from the first value that is a
 * whole 32 byte word.
 *
 * The passport page has the chain's own block hash and passes that first; the
 * Explore sheet and the verify card have only what the pinned document says, so
 * they pass that. A value that is neither gives an empty list rather than a
 * throw: the plate then draws its ground and its words with no cells on it,
 * which says nothing untrue about the picture. A grid drawn from a cut or
 * padded hash would be a different picture from the one on the chain, and this
 * drawing is the only trace of a sealed picture anybody outside the creator
 * ever sees.
 */
export function sealedBits(...values: (string | undefined | null)[]): boolean[] {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    try {
      return sketchBits(value);
    } catch {
      continue;
    }
  }
  return [];
}
