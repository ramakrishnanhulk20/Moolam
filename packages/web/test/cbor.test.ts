import { describe, expect, it } from "vitest";
import { attestationToPoint, decodeCbor } from "@/lib/passkey/cbor";
import { cborEncode, concat, exportPoint, makeP256Key, sha256, type CborValue } from "./fixtures";

const CREDENTIAL_ID = new Uint8Array(32).fill(0xa7);

async function attestationObject(publicKey: CryptoKey, options: { credentialId?: Uint8Array } = {}) {
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", publicKey));
  const credentialId = options.credentialId ?? CREDENTIAL_ID;

  const coseKey = cborEncode(
    new Map<number | string, CborValue>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, raw.subarray(1, 33)],
      [-3, raw.subarray(33, 65)],
    ]),
  );

  const header = new Uint8Array(55);
  header.set(await sha256(new TextEncoder().encode("localhost")), 0);
  header[32] = 0x5d;
  new DataView(header.buffer).setUint16(53, credentialId.length, false);

  const authData = concat(header, credentialId, coseKey);

  return cborEncode(
    new Map<number | string, CborValue>([
      ["fmt", "none"],
      ["attStmt", new Map<number | string, CborValue>()],
      ["authData", authData],
    ]),
  );
}

describe("decodeCbor", () => {
  it("reads the types an attestation object is built from", () => {
    const encoded = cborEncode(
      new Map<number | string, CborValue>([
        ["fmt", "packed"],
        [1, 300],
        [-3, [1, 2, 70000]],
        ["bytes", new Uint8Array([1, 2, 3])],
      ]),
    );

    const decoded = decodeCbor(encoded) as Map<number | string, unknown>;
    expect(decoded.get("fmt")).toBe("packed");
    expect(decoded.get(1)).toBe(300);
    expect(decoded.get(-3)).toEqual([1, 2, 70000]);
    expect(decoded.get("bytes")).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("refuses trailing bytes and a value that ends early", () => {
    const encoded = cborEncode(new Uint8Array([9, 9]));
    expect(() => decodeCbor(concat(encoded, new Uint8Array([0x00])))).toThrow(/followed by bytes/);
    expect(() => decodeCbor(encoded.subarray(0, 2))).toThrow(/ends before it is complete/);
  });
});

describe("attestationToPoint", () => {
  it("finds the same coordinates the raw export gives", async () => {
    const key = await makeP256Key();
    expect(attestationToPoint(await attestationObject(key.publicKey))).toEqual(await exportPoint(key.publicKey));
  });

  it("walks past a credential id of a different length", async () => {
    const key = await makeP256Key();
    const object = await attestationObject(key.publicKey, { credentialId: new Uint8Array(64).fill(0x11) });
    expect(attestationToPoint(object)).toEqual(await exportPoint(key.publicKey));
  });

  it("refuses an attestation object with no authData", () => {
    const object = cborEncode(new Map<number | string, CborValue>([["fmt", "none"]]));
    expect(() => attestationToPoint(object)).toThrow(/no authData/);
  });
});
