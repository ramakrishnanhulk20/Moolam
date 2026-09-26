/**
 * The shapes shared across the verifier. They live in one file so the HTTP
 * layer, the index and the passport sources cannot drift apart.
 */

export type Hex = `0x${string}`;

/** The eight ways a picture can be rotated or mirrored and still be the same picture. */
export type DihedralName =
  | "identity"
  | "rot90"
  | "rot180"
  | "rot270"
  | "mirror"
  | "mirror-rot90"
  | "mirror-rot180"
  | "mirror-rot270";

/** One re-check of a registered picture, as the index recorded the verdict. */
export interface Recheck {
  /** The receiver contract the Chainlink workflow wrote the verdict to, lower-cased. */
  receiver: Hex;
  matched: boolean;
  /** Bits between the fingerprint the workflow recomputed and the one on chain. */
  distance: number;
  /** Unix seconds. */
  at: number;
}

/**
 * What a source knows about the re-checks of one passport: the three counts, and the newest
 * verdict when there is one.
 *
 * A source that does not carry this leaves it off the record entirely, which says "this service
 * cannot tell you" and is not the same answer as a passport nobody has re-checked yet.
 */
export interface PassportRechecks {
  attestations: number;
  matched: number;
  mismatched: number;
  latest: Recheck | null;
}

/**
 * One registered image as the verifier needs it. This mirrors what the registry
 * contract stores, so a chain-backed source and the JSON file source can be
 * swapped without touching the matcher.
 *
 * `phash` is a bigint because it is 64 bits of hash, not a number. JSON sources
 * carry it as a decimal string and convert on load.
 */
export interface PassportRecord {
  id: Hex;
  phash: bigint;
  blockhash: Hex;
  creator: Hex;
  parentId: Hex | null;
  registeredAt: number;
  metadataURI: string;
  rechecks?: PassportRechecks;
}

/**
 * How current the passport index is, as /health and every verify answer publish it. `loadedAt` is
 * the unix second of the last load that worked. `stale` is true once that is more than five
 * refresh periods ago, so a picture registered since may not match yet; a host that never
 * refreshes is never stale (review pass 9, V82).
 */
export interface IndexState {
  loadedAt: number;
  stale: boolean;
}

/** One candidate the index returned, with the variant that produced it. */
export interface Match {
  id: Hex;
  phashDistance: number;
  blockhashDistance: number;
  variant: DihedralName;
  score: number;
}
