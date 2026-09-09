import { describe, expect, it } from "vitest";
import { spkiToPoint } from "@/lib/passkey/spki";
import { exportPoint, makeP256Key } from "./fixtures";

describe("spkiToPoint", () => {
  it("reads the coordinates of a real exported P-256 key", async () => {
    const key = await makeP256Key();
    const spki = new Uint8Array(await crypto.subtle.exportKey("spki", key.publicKey));

    expect(spki.length).toBe(91);
    expect(spkiToPoint(spki)).toEqual(await exportPoint(key.publicKey));
  });

  it("refuses a truncated key, a bent header and a compressed point", async () => {
    const key = await makeP256Key();
    const spki = new Uint8Array(await crypto.subtle.exportKey("spki", key.publicKey));

    expect(() => spkiToPoint(spki.subarray(0, 90))).toThrow(/91 bytes/);

    const bentHeader = Uint8Array.from(spki);
    bentHeader[13] = 0x07;
    expect(() => spkiToPoint(bentHeader)).toThrow(/uncompressed P-256 key/);

    const compressed = Uint8Array.from(spki);
    compressed[26] = 0x02;
    expect(() => spkiToPoint(compressed)).toThrow(/uncompressed form/);
  });
});
