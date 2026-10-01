import type { HammingIndex, Registration } from "../index.js";
import { LOOKALIKE_BLOCKHASH_BITS, LOOKALIKE_PHASH_BITS, registeredBefore } from "../lookalike-rule.js";
import type { Hex } from "../types.js";

/** The thresholds every look-alike question is asked at, straight from the shared rule. */
export const LOOKALIKE_LIMITS = {
  phashMax: LOOKALIKE_PHASH_BITS,
  blockhashMax: LOOKALIKE_BLOCKHASH_BITS,
} as const;

/** One fingerprint of a picture, or of one of its turns and mirrors. */
export interface FingerprintPair {
  phash: bigint;
  blockhash: Hex;
}

/** What the order needs of a passport: its registration second and its id. */
export interface Ordered {
  id: Hex;
  registeredAt: number;
}

/**
 * The look-alike order: the shared rule's registeredAt, strict, and the lower id only to put two
 * passports of one second in a fixed place in a list. Ties are still never "earlier": callers ask
 * `registeredBefore` for that, and this order only sorts.
 */
export function lookalikeOrder(a: Ordered, b: Ordered): number {
  const left = { registeredAt: BigInt(a.registeredAt) };
  const right = { registeredAt: BigInt(b.registeredAt) };
  if (registeredBefore(left, right)) return -1;
  if (registeredBefore(right, left)) return 1;
  const x = a.id.toLowerCase();
  const y = b.id.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Every fingerprint within the shared thresholds of any of `pairs`, each named by its earliest
 * passport registered strictly before the second `before`, in the look-alike order.
 *
 * A fingerprint row is named once, by the first passport in it by the shared rule, so a pile of
 * later copies of one fingerprint never takes more than one place and never outranks the first.
 * The answer is a function of the index and the inputs alone: the same copy asked the same
 * question gives the same list, whoever asks and whenever.
 */
export function lookalikesOf(index: HammingIndex, pairs: readonly FingerprintPair[], before: number): Registration[] {
  const limit = { registeredAt: BigInt(before) };
  const found = new Map<Hex, Registration>();
  for (const pair of pairs) {
    for (const row of index.rowsWithin(pair.phash, pair.blockhash, LOOKALIKE_LIMITS)) {
      let first: Registration | undefined;
      for (const entry of row) {
        if (!registeredBefore({ registeredAt: BigInt(entry.registeredAt) }, limit)) continue;
        if (first === undefined || lookalikeOrder(entry, first) < 0) first = entry;
      }
      if (first !== undefined) found.set(first.id.toLowerCase() as Hex, first);
    }
  }
  return [...found.values()].sort(lookalikeOrder);
}
