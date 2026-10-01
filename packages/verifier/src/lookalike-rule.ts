/**
 * Which passport came first, and how close two fingerprints must be to call the later one a look-alike.
 * The verify service and the Chainlink workflow each keep this file, byte for byte the same (a verifier
 * test reads both), so the warning before signing and the mark Chainlink writes can never disagree.
 */

/** pHash bits apart, of 64, at or under which two pictures look alike. */
export const LOOKALIKE_PHASH_BITS = 10;

/** Blockhash bits apart, of 256, at or under which two pictures look alike. */
export const LOOKALIKE_BLOCKHASH_BITS = 40;

/**
 * Whether passport `a` was registered strictly before passport `b`, by the registry's own registeredAt in
 * whole seconds. Two passports in the same second are never earlier than each other, because Monad seals
 * more than one block a second and the seconds alone cannot order them.
 */
export function registeredBefore(a: { registeredAt: bigint }, b: { registeredAt: bigint }): boolean {
  return a.registeredAt < b.registeredAt;
}
