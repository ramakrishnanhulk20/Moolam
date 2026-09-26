// Covers matchImage: the exact sha256 path, a near match through a transform,
// and an image nobody registered. An exact hit reports the distances measured against the
// passport's stored fingerprint, not zeros it never measured (pass 7, V63).
// Does NOT cover the HTTP layer (see server.test.ts) or the measured match rate
// per transform, which scripts/robustness.ts reports.

import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { dihedralFingerprints } from "../src/dihedral.js";
import { fingerprint, hamming64, hammingHex } from "../src/fingerprint.js";
import { HammingIndex } from "../src/index.js";
import { MATCH_LIMITS, matchImage } from "../src/match.js";
import type { Hex, PassportRecord } from "../src/types.js";
import { makeImage, recordFor } from "./helpers.js";

// The real implementation is kept, wrapped in a spy, so the mirror test below
// still measures real hashes while the exact-hit test can prove the eight
// variants were never built.
vi.mock("../src/dihedral.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/dihedral.js")>();
  return { ...actual, dihedralFingerprints: vi.fn(actual.dihedralFingerprints) };
});

async function registryOf(seeds: number[]): Promise<{
  index: HammingIndex;
  lookup: (sha256: Hex) => PassportRecord | undefined;
  images: Buffer[];
}> {
  const images = await Promise.all(seeds.map((seed) => makeImage(seed)));
  const records = await Promise.all(images.map(async (bytes) => recordFor(await fingerprint(bytes))));
  const byId = new Map(records.map((record) => [record.id, record]));
  return { index: new HammingIndex(records), lookup: (sha256) => byId.get(sha256), images };
}

describe("matchImage", () => {
  it("reports an exact match with full confidence when the bytes are identical", async () => {
    const { index, lookup, images } = await registryOf([21, 22]);
    const result = await matchImage(images[0] as Buffer, index, lookup);

    expect(result.exact).not.toBeNull();
    expect(result.confidence).toBe(1);
    expect(result.best?.phashDistance).toBe(0);
    expect(result.best?.blockhashDistance).toBe(0);
    expect(result.best?.score).toBe(1);
    expect(result.queried.sha256).toBe(result.exact);
  });

  // The registry cannot check that a passport's fingerprint belongs to its bytes, so a passport can
  // carry the bytes of F and the fingerprint of G.
  it("reports the distances measured against the passport's stored fingerprint on an exact hit", async () => {
    const f = await makeImage(21);
    const g = await makeImage(57);
    const [printF, printG] = await Promise.all([fingerprint(f), fingerprint(g)]);
    const bent = recordFor(printG, { id: printF.sha256 });
    const index = new HammingIndex([bent]);

    const result = await matchImage(f, index, (sha256) => (sha256 === bent.id ? bent : undefined));

    const phashDistance = hamming64(printF.phash, printG.phash);
    const blockhashDistance = hammingHex(printF.blockhash, printG.blockhash);
    expect(phashDistance).toBeGreaterThan(MATCH_LIMITS.phashMax);
    expect(result.exact).toBe(bent.id);
    expect(result.confidence).toBe(1);
    expect(result.best).toMatchObject({ id: bent.id, phashDistance, blockhashDistance, variant: "identity" });
    expect(result.best?.score).toBeLessThan(1);
    expect(result.matches[0]).toEqual(result.best);
  });

  it("does no dihedral work when the bytes are an exact hit", async () => {
    const { index, lookup, images } = await registryOf([21, 22]);
    vi.mocked(dihedralFingerprints).mockClear();

    const exact = await matchImage(images[0] as Buffer, index, lookup);
    expect(exact.exact).not.toBeNull();
    expect(dihedralFingerprints).not.toHaveBeenCalled();

    await matchImage(await makeImage(98), index, lookup);
    expect(dihedralFingerprints).toHaveBeenCalledTimes(1);
  });

  it("finds the passport behind a re-encoded and resized copy", async () => {
    const { index, lookup, images } = await registryOf([21, 22]);
    const copy = await sharp(images[1] as Buffer).resize(320).jpeg({ quality: 60 }).toBuffer();

    const result = await matchImage(copy, index, lookup);
    expect(result.exact).toBeNull();
    expect(result.best).not.toBeNull();
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThan(1);
    expect(result.best?.id).toBe((await fingerprint(images[1] as Buffer)).sha256);
  });

  it("labels a mirrored copy with the mirror variant", async () => {
    const { index, lookup, images } = await registryOf([31]);
    const flipped = await sharp(images[0] as Buffer).flop().jpeg({ quality: 92 }).toBuffer();

    const result = await matchImage(flipped, index, lookup);
    expect(result.best?.variant).toBe("mirror");
  });

  it("returns nothing at zero confidence for an unregistered image", async () => {
    const { index, lookup } = await registryOf([21, 22]);
    const stranger = await makeImage(99);

    const result = await matchImage(stranger, index, lookup);
    expect(result.exact).toBeNull();
    expect(result.best).toBeNull();
    expect(result.matches).toHaveLength(0);
    expect(result.confidence).toBe(0);
  });
});
