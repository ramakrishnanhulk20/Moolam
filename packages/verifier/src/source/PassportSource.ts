import type { PassportRecord } from "../types.js";

/**
 * Where the verifier gets its registered passports from.
 *
 * The verifier never talks to a chain directly. It asks a source for the whole
 * record set and builds its index from that, so the same matcher runs against a
 * JSON file in development and against an indexer in production without a line
 * of matching logic changing.
 */
export interface PassportSource {
  load(): Promise<PassportRecord[]>;
}
