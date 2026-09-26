import { hamming64 } from "./fingerprint.js";
import type { Hex, Match, PassportRecord } from "./types.js";

const BLOCKHASH_BYTES = 32;

/**
 * Where a registration sits in chain order, as far as its source can say. The Envio source
 * carries the block each passport landed in. A source that does not leaves it off, and the
 * registration timestamp decides instead.
 */
export interface RegistrationOrder {
  registeredBlock?: number;
}

/** A passport record plus whatever its source knows about its place in chain order. */
export type IndexedRecord = PassportRecord & RegistrationOrder;

/** A match that still knows when the passport it names was registered, so a tie can be settled. */
export interface RankedMatch extends Match, RegistrationOrder {
  registeredAt: number;
}

interface Registration extends RegistrationOrder {
  id: Hex;
  registeredAt: number;
}

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
 * The registry cannot check that a passport's fingerprint belongs to its bytes,
 * so anyone can register copies of someone else's fingerprint. Each distinct
 * fingerprint is therefore one row, and every passport carrying it sits in that
 * row's list in chain order. A query answers with the earliest registration of
 * each row, so a pile of later copies can neither outrank the first passport nor
 * push it out of a capped result.
 *
 * Hashes are held in flat typed arrays rather than in the record objects so the
 * scan walks contiguous memory instead of chasing pointers per candidate.
 */
export class HammingIndex {
  private phashes = new BigUint64Array(0);
  private blockhashes = new Uint8Array(0);
  private groups: Registration[][] = [];
  private keys: string[] = [];
  private rows = 0;
  private records = 0;
  private readonly rowByKey = new Map<string, number>();
  private readonly keyById = new Map<Hex, string>();

  constructor(records: IndexedRecord[] = []) {
    // Loading in chain order means every copy is appended to the end of its row's list.
    const ordered = [...records].sort(compareRegistrations);
    this.reserve(ordered.length);
    for (const record of ordered) {
      this.add(record);
    }
  }

  /** How many records the index currently holds, copies included. */
  get size(): number {
    return this.records;
  }

  /**
   * Adds a record, or replaces the one already stored under the same id.
   *
   * Throws when the blockhash is not 32 bytes of hex or the phash does not fit
   * in 64 bits, because a malformed record would silently poison every later
   * distance.
   */
  add(record: IndexedRecord): void {
    const blockhash = decodeBlockhash(record.blockhash);
    if (record.phash < 0n || record.phash > 0xffffffffffffffffn) {
      throw new Error(`phash for ${record.id} does not fit in 64 bits`);
    }

    this.remove(record.id);

    const key = fingerprintKey(record.phash, blockhash);
    let row = this.rowByKey.get(key);
    if (row === undefined) {
      row = this.rows;
      this.reserve(row + 1);
      this.rows += 1;
      this.phashes[row] = record.phash;
      this.blockhashes.set(blockhash, row * BLOCKHASH_BYTES);
      this.groups[row] = [];
      this.keys[row] = key;
      this.rowByKey.set(key, row);
    }

    insertInOrder(this.groups[row] as Registration[], {
      id: record.id,
      registeredAt: record.registeredAt,
      ...(record.registeredBlock === undefined ? {} : { registeredBlock: record.registeredBlock }),
    });
    this.keyById.set(record.id, key);
    this.records += 1;
  }

  /**
   * Removes a record by id. Unknown ids are ignored.
   *
   * When the record was the last one carrying its fingerprint, the last row is
   * moved into the freed slot so the scan never has to skip holes. That reorders
   * the rows, which is fine: query results are sorted, never read in row order.
   */
  remove(id: Hex): void {
    const key = this.keyById.get(id);
    if (key === undefined) {
      return;
    }
    const row = this.rowByKey.get(key) as number;
    const group = this.groups[row] as Registration[];
    group.splice(
      group.findIndex((entry) => entry.id === id),
      1,
    );
    this.keyById.delete(id);
    this.records -= 1;
    if (group.length > 0) {
      return;
    }

    const last = this.rows - 1;
    if (row !== last) {
      const movedKey = this.keys[last] as string;
      this.phashes[row] = this.phashes[last] as bigint;
      this.blockhashes.copyWithin(row * BLOCKHASH_BYTES, last * BLOCKHASH_BYTES, (last + 1) * BLOCKHASH_BYTES);
      this.groups[row] = this.groups[last] as Registration[];
      this.keys[row] = movedKey;
      this.rowByKey.set(movedKey, row);
    }

    this.groups.length = last;
    this.keys.length = last;
    this.rowByKey.delete(key);
    this.rows = last;
  }

  /**
   * How many passports registered after this one carry exactly its fingerprint.
   * Zero for an id the index does not hold.
   */
  laterSameFingerprint(id: Hex): number {
    const key = this.keyById.get(id);
    if (key === undefined) {
      return 0;
    }
    const group = this.groups[this.rowByKey.get(key) as number] as Registration[];
    return group.length - 1 - group.findIndex((entry) => entry.id === id);
  }

  /**
   * Returns every fingerprint whose pHash and blockhash are both within the
   * given limits, best first, each named by the earliest passport carrying it.
   * A candidate must clear both thresholds: requiring the two independent
   * hashes to agree is what keeps false positives near zero.
   *
   * `limit` caps the returned list, not the scan. It counts fingerprints, so
   * later copies of one never take a place in it.
   */
  query(
    phash: bigint,
    blockhash: Hex,
    limits: { phashMax: number; blockhashMax: number },
    limit = 20,
  ): RankedMatch[] {
    if (limit <= 0) {
      return [];
    }
    const target = decodeBlockhash(blockhash);
    const hits: RankedMatch[] = [];

    for (let position = 0; position < this.rows; position += 1) {
      const phashDistance = hamming64(this.phashes[position] as bigint, phash);
      if (phashDistance > limits.phashMax) {
        continue;
      }
      const blockhashDistance = this.blockhashDistanceAt(position, target);
      if (blockhashDistance > limits.blockhashMax) {
        continue;
      }
      const first = (this.groups[position] as Registration[])[0] as Registration;
      hits.push({
        ...first,
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

/**
 * Orders matches best first: higher score, then the closer pHash, then the closer blockhash, and
 * on a full tie the passport registered first. This is the one place the tie order is decided.
 */
export function compareMatches(a: RankedMatch, b: RankedMatch): number {
  if (b.score !== a.score) {
    return b.score - a.score;
  }
  if (a.phashDistance !== b.phashDistance) {
    return a.phashDistance - b.phashDistance;
  }
  if (a.blockhashDistance !== b.blockhashDistance) {
    return a.blockhashDistance - b.blockhashDistance;
  }
  return compareRegistrations(a, b);
}

/**
 * Chain order: the earlier block, then the earlier timestamp, then the lower id. The index carries
 * no log index, so two registrations in one block fall to the id, which keeps the order stable but
 * is not necessarily the order they were mined in.
 */
function compareRegistrations(a: Registration, b: Registration): number {
  if (a.registeredBlock !== undefined && b.registeredBlock !== undefined && a.registeredBlock !== b.registeredBlock) {
    return a.registeredBlock - b.registeredBlock;
  }
  if (a.registeredAt !== b.registeredAt) {
    return a.registeredAt - b.registeredAt;
  }
  const left = a.id.toLowerCase();
  const right = b.id.toLowerCase();
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Keeps a row's list in chain order. Loading in order makes this an append. */
function insertInOrder(group: Registration[], entry: Registration): void {
  let at = group.length;
  while (at > 0 && compareRegistrations(group[at - 1] as Registration, entry) > 0) {
    at -= 1;
  }
  group.splice(at, 0, entry);
}

/** One spelling per fingerprint, built from the decoded bytes so case and prefix cannot split a row. */
function fingerprintKey(phash: bigint, blockhash: Uint8Array): string {
  return `${phash.toString(16)}:${Buffer.from(blockhash).toString("hex")}`;
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
