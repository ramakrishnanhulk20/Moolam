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
 * How far the indexer behind a source had read when the source loaded, as that same load found it.
 * The block comes from the indexer's own account of itself, never from the newest passport it
 * holds, which measures registrations rather than the indexer.
 */
export interface IndexerProgress {
  /** The newest block the indexer had finished processing. */
  block: number;
  /** That block's time in unix seconds, read from the chain, or null when the chain did not answer. */
  blockTime: number | null;
  /** The chain head's time in unix seconds at the same load, or null when the chain did not answer. */
  headTime: number | null;
  /** True while the indexer says it has not caught up with the chain head, as during a re-sync. */
  syncing: boolean;
}

/**
 * How current the passport index is, as /health and every verify answer publish it. `loadedAt` is
 * the unix second of the last load that worked. `stale` is true once that is more than five
 * refresh periods ago, so a picture registered since may not match yet; a host that never
 * refreshes is never stale on that count (review pass 9, V82).
 *
 * A source with an indexer behind it also says how far that indexer had read: `indexedTo` is its
 * newest processed block and `indexedAt` that block's time in unix seconds, each null when it could
 * not be read. `stale` is then also true when the indexer was more than ten minutes behind the
 * chain head, was still syncing, or either could not be read (review pass 10, V99). A source with
 * no indexer, the JSON file, leaves both off.
 */
export interface IndexState {
  loadedAt: number;
  stale: boolean;
  indexedTo?: number | null;
  indexedAt?: number | null;
}

/** One candidate the index returned, with the variant that produced it. */
export interface Match {
  id: Hex;
  phashDistance: number;
  blockhashDistance: number;
  variant: DihedralName;
  score: number;
}
