// Covers the eight rotated and mirrored variants and the names they carry.
// Does NOT cover rotation by an arbitrary angle such as 15 degrees, which none
// of these variants can undo, or crops combined with a rotation.

import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { dihedralFingerprints, dihedralVariants } from "../src/dihedral.js";
import { fingerprint, hamming64, hammingHex } from "../src/fingerprint.js";
import { makeImage } from "./helpers.js";

describe("dihedralVariants", () => {
  it("returns eight PNG buffers", async () => {
    const variants = await dihedralVariants(await makeImage(5));
    const names = Object.keys(variants);

    expect(names).toHaveLength(8);
    for (const name of names) {
      const buffer = variants[name as keyof typeof variants];
      expect((await sharp(buffer).metadata()).format).toBe("png");
    }
  });

  it("refuses an empty buffer", async () => {
    await expect(dihedralVariants(Buffer.alloc(0))).rejects.toThrow(/non-empty/);
  });
});

describe("dihedralFingerprints", () => {
  it("matches the original under rot90 when the copy was turned a quarter clockwise", async () => {
    const original = await makeImage(7);
    const base = await fingerprint(original);
    const turned = await sharp(original).rotate(90).jpeg({ quality: 92 }).toBuffer();

    const variants = await dihedralFingerprints(turned);
    expect(hamming64(base.phash, variants.rot90.phash)).toBeLessThanOrEqual(10);
    expect(hammingHex(base.blockhash, variants.rot90.blockhash)).toBeLessThanOrEqual(40);
    expect(hamming64(base.phash, variants.identity.phash)).toBeGreaterThan(10);
  });

  it("matches the original under mirror when the copy was flipped left to right", async () => {
    const original = await makeImage(8);
    const base = await fingerprint(original);
    const flipped = await sharp(original).flop().jpeg({ quality: 92 }).toBuffer();

    const variants = await dihedralFingerprints(flipped);
    expect(hamming64(base.phash, variants.mirror.phash)).toBeLessThanOrEqual(10);
    expect(hammingHex(base.blockhash, variants.mirror.blockhash)).toBeLessThanOrEqual(40);
    expect(hamming64(base.phash, variants.identity.phash)).toBeGreaterThan(10);
  });
});
