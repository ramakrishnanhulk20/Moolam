import type { IndexerProgress, PassportRecord } from "../types.js";

/**
 * One load of a source: the records, and how far the indexer behind them had read. `progress` is
 * left off by a source with no indexer, and null when the source has one and could not say how far
 * it had got, which every answer then reads as stale.
 */
export interface SourceLoad {
  records: PassportRecord[];
  progress?: IndexerProgress | null;
}

/**
 * Where the verifier gets its registered passports from.
 *
 * The verifier never talks to a chain directly. It asks a source for the whole
 * record set and builds its index from that, so the same matcher runs against a
 * JSON file in development and against an indexer in production without a line
 * of matching logic changing.
 *
 * A source with an indexer behind it also offers `loadWithProgress`, the same load with the
 * indexer's own progress read beside it, and the service uses that when it is there.
 */
export interface PassportSource {
  load(): Promise<PassportRecord[]>;
  loadWithProgress?(): Promise<SourceLoad>;
}
