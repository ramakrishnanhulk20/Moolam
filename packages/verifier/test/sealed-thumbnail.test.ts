// Covers the thumbnail rule on a plain sealed prepare (review pass 8, intake 5, V72): a picture
// whose thumbnail an unseal would publish cannot fit the Chainlink fetch budget is refused by
// prepareSealed with ThumbnailTooLarge, so no passport is ever made that /unseal would refuse for
// good, and a picture that fits still seals, judged by exactly the thumbnail an unseal publishes.
// Does NOT cover the routes' answer for the refusal, which test/private-copy.test.ts and
// test/attacks-sealed.test.ts cover through /prepare, nor the Chainlink workflow's own fetch.

import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  THUMBNAIL_MAX_BYTES,
  ThumbnailTooLarge,
  makeThumbnail,
  prepareSealed,
  recheckThumbnail,
} from "../src/prepare.js";
import { makeImage } from "./helpers.js";

const SETTINGS = { title: "Sealed", claimGenerator: "moolam-studio/0.1.0", action: "c2pa.opened" } as const;

/** Pure noise at full quality: the reviewer's very detailed picture, whose thumbnail stays over 60 KB. */
async function makeNoiseImage(): Promise<Buffer> {
  const side = 512;
  const raw = Buffer.alloc(side * side * 3);
  let state = 12345;
  for (let i = 0; i < raw.length; i += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    raw[i] = (state >> 16) & 0xff;
  }
  return await sharp(raw, { raw: { width: side, height: side, channels: 3 } }).jpeg({ quality: 100 }).toBuffer();
}

describe("V72: a plain sealed prepare is held to the thumbnail an unseal would publish", () => {
  it("refuses the reviewer's very detailed picture sealed without a private re-check", async () => {
    const refused = prepareSealed(await makeNoiseImage(), SETTINGS);

    await expect(refused).rejects.toBeInstanceOf(ThumbnailTooLarge);
    await expect(refused).rejects.toMatchObject({ limit: THUMBNAIL_MAX_BYTES });
  }, 60_000);

  it("still seals a picture that fits, and the re-check thumbnail is exactly what an unseal would publish", async () => {
    const sealed = await prepareSealed(await makeImage(81), SETTINGS);

    expect(sealed.embedded).toBe(true);
    const judged = await recheckThumbnail(sealed.bytes);
    expect(judged.equals(await makeThumbnail(sealed.bytes))).toBe(true);
    expect(judged.length).toBeLessThanOrEqual(THUMBNAIL_MAX_BYTES);
  }, 60_000);

  it("refuses in recheckThumbnail too, rather than hand back a thumbnail over the budget", async () => {
    await expect(recheckThumbnail(await makeNoiseImage())).rejects.toBeInstanceOf(ThumbnailTooLarge);
  }, 60_000);
});
