// Covers matchImage: the exact sha256 path, a near match through a transform,
// and an image nobody registered.
// Does NOT cover the HTTP layer (see server.test.ts) or the measured match rate
// per transform, which scripts/robustness.ts reports.

import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { fingerprint } from "../src/fingerprint.js";
import { HammingIndex } from "../src/index.js";
import { matchImage } from "../src/match.js";
import type { Hex, PassportRecord } from "../src/types.js";
import { makeImage, recordFor } from "./helpers.js";

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
    expect(result.queried.sha256).toBe(result.exact);
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
