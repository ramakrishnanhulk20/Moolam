// Covers the three fingerprints and the two Hamming helpers, and the header gate every upload
// passes: only JPEG, PNG and WebP get through it, and the review's SVG is refused before anything
// renders it (pass 4, V17). From review pass 5: a picture with transparency matches the passport
// registered from it (intake 3), a picture without it hashes exactly as the two libraries do on
// their own, and the blockhash, now worked out on a worker thread, is the same bits as before on
// every fixture (answers 1). From review pass 7 (V56): a blockhash worker is retired after a job
// whose JPEG decoder threw, as the WebAssembly decoder does on a CMYK file and leaks when it does,
// and once the bytes it was handed pass 64 MB, so the reviewer's padded file cannot pile up inside
// one long-lived worker; the hash that comes back is the one imghash gives on its own.
// Does NOT cover how the hashes behave under real transforms, which is what
// scripts/robustness.ts measures, nor AVIF, HEIF or JPEG XL files, which are refused by the same
// rule and are not built here.

import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { dihedralFingerprints } from "../src/dihedral.js";
import { PACKAGE_ROOT } from "../src/env.js";
import { uprightImage } from "../src/prepare.js";
import {
  BLOCKHASH_MATCH_THRESHOLD,
  PHASH_MATCH_THRESHOLD,
  ImageTooLarge,
  MAX_IMAGE_PIXELS,
  UnsupportedImageFormat,
  blockhashWorkersRetired,
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

const require = createRequire(import.meta.url);
const sharpPhash = require("sharp-phash") as (input: Buffer) => Promise<string>;
const imghash = require("imghash") as { hash: (input: Buffer, bits: number, format: "hex") => Promise<string> };

/** Red, blue and green shapes on a fully transparent background: how a logo or a sticker travels. */
async function transparentPicture(format: "png" | "webp"): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="700">
    <circle cx="250" cy="240" r="170" fill="#d0312d"/>
    <rect x="480" y="120" width="300" height="260" fill="#1f4fbf"/>
    <polygon points="200,640 420,420 640,660" fill="#2e8b3a"/>
  </svg>`;
  const pipeline = sharp(Buffer.from(svg));
  return format === "png" ? await pipeline.png().toBuffer() : await pipeline.webp({ quality: 90, alphaQuality: 100 }).toBuffer();
}

describe("intake 3: transparency", () => {
  it("matches a transparent PNG and WebP to the passport registered from them, on every variant", async () => {
    for (const format of ["png", "webp"] as const) {
      const upload = await transparentPicture(format);
      expect((await sharp(upload).metadata()).hasAlpha, format).toBe(true);

      // Registration flattens onto white before signing; the query has to see the same picture.
      const record = recordFor(await fingerprint(await uprightImage(upload)));
      const result = await matchImage(upload, new HammingIndex([record]), () => undefined);

      expect(result.best?.id, format).toBe(record.id);
      expect(result.best?.variant, format).toBe("identity");
      const identity = await fingerprint(upload);
      expect(hamming64(identity.phash, record.phash), format).toBeLessThanOrEqual(PHASH_MATCH_THRESHOLD);
      expect(hammingHex(identity.blockhash, record.blockhash), format).toBeLessThanOrEqual(BLOCKHASH_MATCH_THRESHOLD);

      const turned = await dihedralFingerprints(await sharp(upload).rotate(90).png().toBuffer());
      expect(hamming64(turned.rot90.phash, record.phash), format).toBeLessThanOrEqual(PHASH_MATCH_THRESHOLD);
      expect(hammingHex(turned.rot90.blockhash, record.blockhash), format).toBeLessThanOrEqual(BLOCKHASH_MATCH_THRESHOLD);
    }
  }, 60_000);

  it("hashes every upright fixture with no alpha exactly as the two libraries do on their own", async () => {
    const folders = [path.join(PACKAGE_ROOT, "test-assets"), path.join(PACKAGE_ROOT, "test", "fixtures")];
    const files = folders.flatMap((folder) =>
      readdirSync(folder)
        .filter((name) => /\.(jpe?g|png)$/i.test(name))
        .map((name) => path.join(folder, name)),
    );
    const pictures = [
      ...files.map((file) => ({ name: path.basename(file), bytes: readFileSync(file) })),
      { name: "generated jpeg", bytes: await makeImage(3) },
      { name: "generated png", bytes: await makeImage(4, "png") },
      { name: "generated webp", bytes: await makeImage(5, "webp") },
    ];
    expect(files.length).toBeGreaterThanOrEqual(10);

    for (const picture of pictures) {
      const meta = await sharp(picture.bytes).metadata();
      if (meta.hasAlpha || (meta.orientation ?? 1) !== 1) {
        continue;
      }
      const print = await fingerprint(picture.bytes);
      expect(print.phash, picture.name).toBe(BigInt(`0b${await sharpPhash(picture.bytes)}`));
      expect(print.blockhash, picture.name).toBe(`0x${await imghash.hash(picture.bytes, 16, "hex")}`);
    }
  }, 120_000);
});

/** A 64 x 64 JPEG stored as CMYK, which the WebAssembly JPEG decoder refuses after its header. */
async function cmykJpeg(): Promise<Buffer> {
  return await sharp({ create: { width: 64, height: 64, channels: 3, background: "#806040" } })
    .toColourspace("cmyk")
    .jpeg({ quality: 90 })
    .toBuffer();
}

/** A JPEG padded with APP15 segments to about `megabytes` MB, the way the reviewer built theirs. */
function padded(jpeg: Buffer, megabytes: number): Buffer {
  const payload = Buffer.alloc(65_000, 0x41);
  const segment = Buffer.concat([Buffer.from([0xff, 0xef, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);
  const count = Math.ceil((megabytes * 1_000_000) / segment.length);
  return Buffer.concat([jpeg.subarray(0, 2), ...Array.from({ length: count }, () => segment), jpeg.subarray(2)]);
}

describe("V56: a blockhash worker is replaced before a leaking decoder can fill it", () => {
  it("retires the worker after a job whose JPEG decoder threw, and still answers imghash's own hash", async () => {
    const cmyk = await cmykJpeg();
    expect((await sharp(cmyk).metadata()).space).toBe("cmyk");
    const before = blockhashWorkersRetired();

    const print = await fingerprint(cmyk);

    expect(print.blockhash).toBe(`0x${await imghash.hash(cmyk, 16, "hex")}`);
    expect(blockhashWorkersRetired()).toBe(before + 1);
    await fingerprint(await makeImage(3));
    expect(blockhashWorkersRetired()).toBe(before + 1);
  }, 30_000);

  it("retires a worker once the bytes it was handed pass 64 MB, however small the pictures", async () => {
    const heavy = padded(await makeImage(9), 15);
    expect((await readImageHeader(heavy)).width * (await readImageHeader(heavy)).height).toBeLessThan(1_000_000);
    const before = blockhashWorkersRetired();

    for (let call = 0; call < 10; call += 1) {
      await fingerprint(heavy);
    }

    // 150 MB in 15 MB jobs: a worker is let go on the job that takes it past 64 MB, so two or three.
    const retired = blockhashWorkersRetired() - before;
    expect(retired).toBeGreaterThanOrEqual(2);
    expect(retired).toBeLessThanOrEqual(3);
  }, 120_000);

  it("gives the reviewer's padded CMYK file the same hash every time, one fresh worker per call", async () => {
    const reviewers = padded(await cmykJpeg(), 19.5);
    expect(reviewers.length).toBeGreaterThan(19_000_000);
    const before = blockhashWorkersRetired();

    const prints = [];
    for (let call = 0; call < 3; call += 1) {
      prints.push((await fingerprint(reviewers)).blockhash);
    }

    expect(new Set(prints).size).toBe(1);
    expect(blockhashWorkersRetired() - before).toBe(3);
  }, 60_000);
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
