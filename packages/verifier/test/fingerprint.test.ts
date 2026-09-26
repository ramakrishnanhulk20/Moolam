// Covers the three fingerprints and the two Hamming helpers, and the header gate every upload
// passes: only JPEG, PNG and WebP get through it, and the review's SVG is refused before anything
// renders it (pass 4, V17).
// Does NOT cover how the hashes behave under real transforms, which is what
// scripts/robustness.ts measures, nor AVIF, HEIF or JPEG XL files, which are refused by the same
// rule and are not built here.

import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  ImageTooLarge,
  MAX_IMAGE_PIXELS,
  UnsupportedImageFormat,
  fingerprint,
  hamming64,
  hammingHex,
  readImageHeader,
} from "../src/fingerprint.js";
import type { Hex } from "../src/types.js";
import { HammingIndex } from "../src/index.js";
import { matchImage } from "../src/match.js";
import { FILTER_BOMB_SVG, makeImage, makeOversizeImage, makeRotatedImage, recordFor } from "./helpers.js";

describe("V17: the formats an upload may be", () => {
  it("refuses the review's SVG in milliseconds, before sharp renders a pixel of it", async () => {
    expect(FILTER_BOMB_SVG.length).toBeLessThan(300);
    const started = performance.now();

    await expect(readImageHeader(FILTER_BOMB_SVG)).rejects.toBeInstanceOf(UnsupportedImageFormat);
    await expect(fingerprint(FILTER_BOMB_SVG)).rejects.toBeInstanceOf(UnsupportedImageFormat);

    expect(performance.now() - started).toBeLessThan(500);
  });

  it("refuses a GIF and a TIFF, which sharp reads and the studio does not take", async () => {
    const flat = sharp({ create: { width: 32, height: 32, channels: 3, background: "#336699" } });
    for (const bytes of [await flat.clone().gif().toBuffer(), await flat.clone().tiff().toBuffer()]) {
      await expect(readImageHeader(bytes)).rejects.toBeInstanceOf(UnsupportedImageFormat);
    }
  });

  it("takes the three formats the web's ACCEPT list names", async () => {
    for (const format of ["jpeg", "png", "webp"] as const) {
      expect((await readImageHeader(await makeImage(5, format))).format).toBe(format);
    }
  });
});

describe("fingerprint", () => {
  it("gives the same three hashes for the same bytes every time", async () => {
    const bytes = await makeImage(3);
    const first = await fingerprint(bytes);
    const second = await fingerprint(Buffer.from(bytes));

    expect(second.sha256).toBe(first.sha256);
    expect(second.phash).toBe(first.phash);
    expect(second.blockhash).toBe(first.blockhash);
    expect(first.sha256).toMatch(/^0x[0-9a-f]{64}$/);
    expect(first.blockhash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(first.width).toBe(640);
    expect(first.height).toBe(480);
    expect(first.format).toBe("jpeg");
  });

  it("gives different pictures different perceptual hashes", async () => {
    const a = await fingerprint(await makeImage(1));
    const b = await fingerprint(await makeImage(12));

    expect(a.sha256).not.toBe(b.sha256);
    expect(hamming64(a.phash, b.phash)).toBeGreaterThan(10);
  });

  it("refuses an empty buffer", async () => {
    await expect(fingerprint(Buffer.alloc(0))).rejects.toThrow(/non-empty/);
  });

  it("refuses an image that unpacks to more pixels than the decode limit", async () => {
    const bomb = await makeOversizeImage();

    expect(bomb.length).toBeLessThan(1_000_000);
    await expect(fingerprint(bomb)).rejects.toBeInstanceOf(ImageTooLarge);
    await expect(fingerprint(bomb)).rejects.toThrow(new RegExp(`${MAX_IMAGE_PIXELS} pixel limit`));
  }, 30_000);
});

describe("orientation", () => {
  it("gives a sideways phone photo the same two hashes as its turned copy", async () => {
    const { tagged, upright } = await makeRotatedImage(7);

    const sideways = await fingerprint(tagged);
    const turned = await fingerprint(upright);

    expect(sideways.sha256).not.toBe(turned.sha256);
    expect(sideways.width).toBe(turned.width);
    expect(hamming64(sideways.phash, turned.phash)).toBeLessThanOrEqual(2);
    expect(hammingHex(sideways.blockhash, turned.blockhash)).toBeLessThanOrEqual(2);
  });

  it("still matches the registered file itself exactly", async () => {
    const { tagged } = await makeRotatedImage(8);
    const record = recordFor(await fingerprint(tagged));
    const byId = new Map([[record.id, record]]);

    const result = await matchImage(tagged, new HammingIndex([record]), (sha256) => byId.get(sha256));
    expect(result.exact).toBe(record.id);
    expect(result.confidence).toBe(1);
  });
});

describe("hamming64", () => {
  it("counts differing bits on known pairs", () => {
    expect(hamming64(0n, 0n)).toBe(0);
    expect(hamming64(0n, 1n)).toBe(1);
    expect(hamming64(0b1011n, 0b1101n)).toBe(2);
    expect(hamming64(0n, 0xffffffffffffffffn)).toBe(64);
    expect(hamming64(0xffffffffffffffffn, 0x7fffffffffffffffn)).toBe(1);
  });
});

describe("hammingHex", () => {
  it("counts differing bits on known pairs", () => {
    const zero = `0x${"0".repeat(64)}` as Hex;
    const ones = `0x${"f".repeat(64)}` as Hex;
    expect(hammingHex(zero, zero)).toBe(0);
    expect(hammingHex(zero, ones)).toBe(256);
    expect(hammingHex(zero, `0x${"0".repeat(63)}7` as Hex)).toBe(3);
    expect(hammingHex("0xABCD" as Hex, "0xabcd" as Hex)).toBe(0);
  });

  it("refuses hashes of different lengths", () => {
    expect(() => hammingHex("0x00" as Hex, "0x0000" as Hex)).toThrow(/equal length/);
  });
});
