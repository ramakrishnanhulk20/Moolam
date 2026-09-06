// Covers the three fingerprints and the two Hamming helpers.
// Does NOT cover how the hashes behave under real transforms, which is what
// scripts/robustness.ts measures, nor non-image input beyond the empty buffer.

import { describe, expect, it } from "vitest";
import { fingerprint, hamming64, hammingHex } from "../src/fingerprint.js";
import type { Hex } from "../src/types.js";
import { makeImage } from "./helpers.js";

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
