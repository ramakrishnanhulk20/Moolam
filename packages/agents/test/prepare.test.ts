// Covers what prepareImage registers when a photo arrives sideways: the rotation is baked into
// the signed original, so the stored fingerprint, the thumbnail and anything that recomputes the
// hash later all describe the same picture.
// Does NOT cover the C2PA manifest round trip, which packages/verifier/test/c2pa.test.ts covers,
// nor the Chainlink sandbox decoding the thumbnail, which the workflow package proves.

import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { fingerprint, hamming64 } from "@moolam/verifier/src/fingerprint.js";
import { prepareImage } from "../src/media/prepare.js";

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480">
  <rect width="640" height="480" fill="#101830"/>
  <circle cx="170" cy="140" r="80" fill="#f2c14e"/>
  <rect x="330" y="300" width="220" height="90" fill="#4fe6d2"/>
</svg>`;

/** A landscape picture stored sideways with EXIF orientation 6, the way a phone writes it. */
async function sidewaysPhoto(): Promise<{ tagged: Buffer; upright: Buffer }> {
  const upright = await sharp(Buffer.from(SVG)).jpeg({ quality: 92 }).toBuffer();
  const stored = await sharp(upright).rotate(270).jpeg({ quality: 92 }).toBuffer();
  return { tagged: await sharp(stored).withMetadata({ orientation: 6 }).jpeg({ quality: 92 }).toBuffer(), upright };
}

describe("prepareImage", () => {
  it("bakes the EXIF rotation into the file it signs, the fingerprint and the thumbnail", async () => {
    const { tagged, upright } = await sidewaysPhoto();
    expect((await sharp(tagged).metadata()).orientation).toBe(6);

    const prepared = await prepareImage(tagged, {
      title: "moolam-orientation.jpg",
      claimGenerator: "moolam-agents/0.1.0",
      action: "c2pa.created",
    });

    const registered = await sharp(prepared.original).metadata();
    expect(registered.orientation ?? 1).toBe(1);
    expect(registered.width).toBe(640);
    expect(registered.height).toBe(480);

    const thumbnail = await sharp(prepared.thumbnail).metadata();
    expect(thumbnail.width).toBeGreaterThan(thumbnail.height ?? 0);

    const uprightPrint = await fingerprint(upright);
    expect(hamming64(prepared.fingerprint.phash, uprightPrint.phash)).toBeLessThanOrEqual(2);
    expect(prepared.manifest.softBinding?.phash).toBe(prepared.fingerprint.phash);
  }, 60_000);
});
