import { hamming64 } from "./fingerprint.js";
import type { Hex, Match, PassportRecord } from "./types.js";

const BLOCKHASH_BYTES = 32;

/**
 * An in-memory nearest-neighbour index over the registered fingerprints.
 *
 * It is a brute-force scan on purpose. A 64-bit XOR plus popcount and a 32-byte
 * table lookup is a handful of nanoseconds, so a laptop clears a million
 * records in well under a second, which is far more headroom than the registry
 * will need. Every sublinear alternative for Hamming space (a BK-tree, or
 * multi-index hashing) costs build time, memory and correctness risk near the
 * threshold, and none of that is worth paying before the record count reaches
 * roughly a million. Past that point the replacement is multi-index hashing:
 * split each hash into r contiguous chunks, put every chunk in its own hash
 * table, and use the pigeonhole rule that a match within d bits must agree
 * exactly on at least one chunk when r > d.
 *
 * Hashes are held in flat typed arrays rather than in the record objects so the
 * scan walks contiguous memory instead of chasing pointers per candidate.
 */
export class HammingIndex {
  private ids: Hex[] = [];
  private phashes = new BigUint64Array(0);
  private blockhashes = new Uint8Array(0);
  private count = 0;
  private readonly positionById = new Map<Hex, number>();

  constructor(records: PassportRecord[] = []) {
    this.reserve(records.length);
    for (const record of records) {
      this.add(record);
    }
  }

  /** How many records the index currently holds. */
  get size(): number {
    return this.count;
  }

  /**
   * Adds a record, or replaces the one already stored under the same id.
   *
   * Throws when the blockhash is not 32 bytes of hex or the phash does not fit
   * in 64 bits, because a malformed record would silently poison every later
   * distance.
   */
  add(record: PassportRecord): void {
    const blockhash = decodeBlockhash(record.blockhash);
    if (record.phash < 0n || record.phash > 0xffffffffffffffffn) {
      throw new Error(`phash for ${record.id} does not fit in 64 bits`);
    }

    const existing = this.positionById.get(record.id);
    const position = existing ?? this.count;
    if (existing === undefined) {
      this.reserve(this.count + 1);
      this.count += 1;
      this.positionById.set(record.id, position);
    }

    this.ids[position] = record.id;
    this.phashes[position] = record.phash;
    this.blockhashes.set(blockhash, position * BLOCKHASH_BYTES);
  }

  /**
   * Removes a record by id. Unknown ids are ignored.
   *
   * The last row is moved into the freed slot so the scan never has to skip
   * holes. That reorders the array, which is fine: query results are sorted by
   * score, never by insertion order.
   */
  remove(id: Hex): void {
    const position = this.positionById.get(id);
    if (position === undefined) {
      return;
    }

    const last = this.count - 1;
    if (position !== last) {
      const movedId = this.ids[last] as Hex;
      this.ids[position] = movedId;
      this.phashes[position] = this.phashes[last] as bigint;
      this.blockhashes.copyWithin(position * BLOCKHASH_BYTES, last * BLOCKHASH_BYTES, (last + 1) * BLOCKHASH_BYTES);
      this.positionById.set(movedId, position);
    }

    this.ids.length = last;
    this.positionById.delete(id);
    this.count = last;
  }

  /**
   * Returns every record whose pHash and blockhash are both within the given
   * limits, best first. A candidate must clear both thresholds: requiring the
   * two independent hashes to agree is what keeps false positives near zero.
   *
   * `limit` caps the returned list, not the scan.
   */
  query(
    phash: bigint,
    blockhash: Hex,
    limits: { phashMax: number; blockhashMax: number },
    limit = 20,
  ): Match[] {
    if (limit <= 0) {
      return [];
    }
    const target = decodeBlockhash(blockhash);
    const hits: Match[] = [];

    for (let position = 0; position < this.count; position += 1) {
      const phashDistance = hamming64(this.phashes[position] as bigint, phash);
      if (phashDistance > limits.phashMax) {
        continue;
      }
      const blockhashDistance = this.blockhashDistanceAt(position, target);
      if (blockhashDistance > limits.blockhashMax) {
        continue;
      }
      hits.push({
        id: this.ids[position] as Hex,
        phashDistance,
        blockhashDistance,
        variant: "identity",
        score: score(phashDistance, blockhashDistance, limits),
      });
    }

    hits.sort(compareMatches);
    return hits.slice(0, limit);
  }

  private blockhashDistanceAt(position: number, target: Uint8Array): number {
    const base = position * BLOCKHASH_BYTES;
    let bits = 0;
    for (let i = 0; i < BLOCKHASH_BYTES; i += 1) {
      let byte = (this.blockhashes[base + i] as number) ^ (target[i] as number);
      while (byte !== 0) {
        byte &= byte - 1;
        bits += 1;
      }
    }
    return bits;
  }

  private reserve(wanted: number): void {
    if (wanted <= this.phashes.length) {
      return;
    }
    const capacity = Math.max(16, wanted, this.phashes.length * 2);
    const phashes = new BigUint64Array(capacity);
    phashes.set(this.phashes);
    const blockhashes = new Uint8Array(capacity * BLOCKHASH_BYTES);
    blockhashes.set(this.blockhashes);
    this.phashes = phashes;
    this.blockhashes = blockhashes;
  }
}

/**
 * Turns two bit distances into one number in (0, 1] where 1 is an identical
 * pair. Each distance is scored against its own threshold so the 64-bit and
 * 256-bit hashes contribute on the same scale, and the pHash carries the
 * heavier weight because the spike measured it as the more stable of the two
 * under honest re-encoding.
 */
export function score(
  phashDistance: number,
  blockhashDistance: number,
  limits: { phashMax: number; blockhashMax: number },
): number {
  const phashPart = 1 - phashDistance / (limits.phashMax + 1);
  const blockhashPart = 1 - blockhashDistance / (limits.blockhashMax + 1);
  return 0.6 * phashPart + 0.4 * blockhashPart;
}

/** Orders matches best first: higher score, then the closer pHash as a tiebreak. */
export function compareMatches(a: Match, b: Match): number {
  if (b.score !== a.score) {
    return b.score - a.score;
  }
  if (a.phashDistance !== b.phashDistance) {
    return a.phashDistance - b.phashDistance;
  }
  return a.blockhashDistance - b.blockhashDistance;
}

function decodeBlockhash(value: Hex): Uint8Array {
  const hex = value.startsWith("0x") ? value.slice(2) : value;
  if (hex.length !== BLOCKHASH_BYTES * 2) {
    throw new Error(`blockhash must be ${BLOCKHASH_BYTES * 2} hex characters, got ${hex.length}`);
  }
  const out = new Uint8Array(BLOCKHASH_BYTES);
  for (let i = 0; i < BLOCKHASH_BYTES; i += 1) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error("blockhash must be hex prefixed with 0x");
    }
    out[i] = byte;
  }
  return out;
}
