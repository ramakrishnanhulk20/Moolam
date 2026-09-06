// Covers HammingIndex: adding, replacing, removing, both thresholds and the
// order results come back in.
// Does NOT cover the dihedral variants (see dihedral.test.ts) or performance at
// registry scale, which the brute-force comment in src/index.ts argues for
// rather than measures.

import { describe, expect, it } from "vitest";
import { HammingIndex } from "../src/index.js";
import type { PassportRecord } from "../src/types.js";
import { blockhashWithBits, idFrom } from "./helpers.js";

const LIMITS = { phashMax: 10, blockhashMax: 40 };

function record(byte: number, phash: bigint, blockhashBits: number): PassportRecord {
  return {
    id: idFrom(byte),
    phash,
    blockhash: blockhashWithBits(blockhashBits),
    creator: "0x2222222222222222222222222222222222222222",
    parentId: null,
    registeredAt: 1,
    metadataURI: "ipfs://x",
  };
}

describe("HammingIndex", () => {
  it("counts records and replaces one added twice under the same id", () => {
    const index = new HammingIndex([record(1, 0n, 0)]);
    expect(index.size).toBe(1);

    index.add(record(1, 0b111n, 0));
    expect(index.size).toBe(1);
    expect(index.query(0b111n, blockhashWithBits(0), LIMITS)[0]?.phashDistance).toBe(0);
  });

  it("returns the closest match first", () => {
    const index = new HammingIndex([
      record(1, 0b1111n, 0),
      record(2, 0b11n, 0),
      record(3, 0n, 0),
    ]);

    const hits = index.query(0n, blockhashWithBits(0), LIMITS);
    expect(hits.map((hit) => hit.id)).toEqual([idFrom(3), idFrom(2), idFrom(1)]);
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 1);
    expect(hits[0]?.variant).toBe("identity");
  });

  it("drops a record whose pHash is past the threshold", () => {
    const index = new HammingIndex([record(1, 0b11111111111n, 0)]);
    expect(index.query(0n, blockhashWithBits(0), LIMITS)).toHaveLength(0);
    expect(index.query(0n, blockhashWithBits(0), { phashMax: 11, blockhashMax: 40 })).toHaveLength(1);
  });

  it("drops a record whose blockhash is past the threshold even when the pHash is perfect", () => {
    const index = new HammingIndex([record(1, 0n, 41)]);
    expect(index.query(0n, blockhashWithBits(0), LIMITS)).toHaveLength(0);
    expect(index.query(0n, blockhashWithBits(0), { phashMax: 10, blockhashMax: 41 })).toHaveLength(1);
  });

  it("honours the result limit without changing the order", () => {
    const index = new HammingIndex([record(1, 0b1n, 0), record(2, 0n, 0), record(3, 0b11n, 0)]);
    expect(index.query(0n, blockhashWithBits(0), LIMITS, 2).map((hit) => hit.id)).toEqual([idFrom(2), idFrom(1)]);
    expect(index.query(0n, blockhashWithBits(0), LIMITS, 0)).toHaveLength(0);
  });

  it("removes a record and ignores an unknown id", () => {
    const index = new HammingIndex([record(1, 0n, 0), record(2, 0b1n, 0)]);
    index.remove(idFrom(9));
    expect(index.size).toBe(2);

    index.remove(idFrom(1));
    expect(index.size).toBe(1);
    expect(index.query(0n, blockhashWithBits(0), LIMITS).map((hit) => hit.id)).toEqual([idFrom(2)]);
  });

  it("refuses a malformed record rather than poisoning later distances", () => {
    const index = new HammingIndex();
    expect(() => index.add({ ...record(1, 0n, 0), blockhash: "0x00" })).toThrow(/64 hex characters/);
    expect(() => index.add({ ...record(1, 0n, 0), phash: 1n << 64n })).toThrow(/64 bits/);
  });
});
