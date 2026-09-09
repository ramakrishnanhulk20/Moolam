import { describe, expect, it } from "vitest";
import { P256_ORDER, derToRS, lowS, toBytes32 } from "@/lib/passkey/der";
import { encodeDerSignature } from "./fixtures";

const R = 0x2b1c7e4f9a3d5b8e1f0a6c4d2e9b7a5c3f1d8e6b4a2c09f7e5d3b1a8c6e4f2d0n;
const HIGH_BIT_R = 0xf1c7e4f9a3d5b8e1f0a6c4d2e9b7a5c3f1d8e6b4a2c09f7e5d3b1a8c6e4f2d0an;
const S = 0x0f3a5c7e9b1d2f4a6c8e0a2c4e6f8a1b3d5f7092b4d6f8a0c2e4f60718293a4bn;

describe("derToRS", () => {
  it("reads r and s out of a DER signature", () => {
    expect(derToRS(encodeDerSignature(R, S))).toEqual({ r: R, s: S });
  });

  it("reads a scalar that carries the leading zero DER adds to keep it positive", () => {
    const encoded = encodeDerSignature(HIGH_BIT_R, S);
    // 0x30 len 0x02 len, then the padding byte the encoder had to add.
    expect(encoded[4]).toBe(0x00);
    expect(encoded[3]).toBe(33);
    expect(derToRS(encoded)).toEqual({ r: HIGH_BIT_R, s: S });
  });

  it("refuses a leading zero that was not needed", () => {
    const good = encodeDerSignature(R, S);
    const padded = new Uint8Array(good.length + 1);
    padded.set(good.subarray(0, 2));
    padded[1] = good[1] + 1;
    padded[2] = 0x02;
    padded[3] = good[3] + 1;
    padded[4] = 0x00;
    padded.set(good.subarray(4), 5);
    expect(() => derToRS(padded)).toThrow(/leading zero/);
  });

  it("refuses bytes that are not a SEQUENCE, a wrong length, or trailing junk", () => {
    const good = encodeDerSignature(R, S);

    const notSequence = Uint8Array.from(good);
    notSequence[0] = 0x31;
    expect(() => derToRS(notSequence)).toThrow(/SEQUENCE/);

    const wrongLength = Uint8Array.from(good);
    wrongLength[1] = good[1] - 1;
    expect(() => derToRS(wrongLength)).toThrow(/claims/);

    const trailing = new Uint8Array([...good, 0x00]);
    trailing[1] = good[1] + 1;
    expect(() => derToRS(trailing)).toThrow(/after the second INTEGER/);
  });
});

describe("lowS", () => {
  it("leaves a signature in the lower half alone", () => {
    expect(lowS(S)).toBe(S);
  });

  it("folds a high s to n - s, which is what the contract accepts", () => {
    const high = P256_ORDER - S;
    expect(high > P256_ORDER >> 1n).toBe(true);
    expect(lowS(high)).toBe(S);
  });

  it("reads a high s out of DER and normalises it", () => {
    const high = P256_ORDER - S;
    const parsed = derToRS(encodeDerSignature(R, high));
    expect(parsed.s).toBe(high);
    expect(lowS(parsed.s)).toBe(S);
  });
});

describe("toBytes32", () => {
  it("pads to 32 bytes", () => {
    expect(toBytes32(1n)).toBe(`0x${"0".repeat(63)}1`);
    expect(toBytes32(S)).toBe(`0x${S.toString(16).padStart(64, "0")}`);
  });

  it("refuses a value that does not fit", () => {
    expect(() => toBytes32(1n << 256n)).toThrow(/32 bytes/);
    expect(() => toBytes32(-1n)).toThrow(/32 bytes/);
  });
});
