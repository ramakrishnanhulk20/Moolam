import { describe, expect, it } from "vitest";
import { CborTooDeep, WrongCurve, attestationToPoint, decodeCbor } from "@/lib/passkey/cbor";
import { cborEncode, concat, exportPoint, makeP256Key, sha256, type CborValue } from "./fixtures";

const CREDENTIAL_ID = new Uint8Array(32).fill(0xa7);

interface AttestationOptions {
  credentialId?: Uint8Array;
  /** The COSE key type, algorithm and curve, for the keys that are not P-256. */
  cose?: { kty: number; alg: number; crv: number };
}

async function attestationObject(publicKey: CryptoKey, options: AttestationOptions = {}) {
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", publicKey));
  const credentialId = options.credentialId ?? CREDENTIAL_ID;
  const cose = options.cose ?? { kty: 2, alg: -7, crv: 1 };

  const coseKey = cborEncode(
    new Map<number | string, CborValue>([
      [1, cose.kty],
      [3, cose.alg],
      [-1, cose.crv],
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

  it("refuses a secp256k1 key, whose coordinates are the same size as a P-256 key's", async () => {
    const key = await makeP256Key();
    // kty 2 with alg -47 and crv 8 is how an authenticator names secp256k1.
    const object = await attestationObject(key.publicKey, { cose: { kty: 2, alg: -47, crv: 8 } });

    expect(() => attestationToPoint(object)).toThrow(WrongCurve);
    expect(() => attestationToPoint(object)).toThrow(/algorithm -47/);
  });

  it("refuses a key that is not an elliptic curve key at all", async () => {
    const key = await makeP256Key();
    const object = await attestationObject(key.publicKey, { cose: { kty: 3, alg: -7, crv: 1 } });

    expect(() => attestationToPoint(object)).toThrow(WrongCurve);
  });

  it("refuses an EC2 ES256 key that names another curve", async () => {
    const key = await makeP256Key();
    const object = await attestationObject(key.publicKey, { cose: { kty: 2, alg: -7, crv: 6 } });

    expect(() => attestationToPoint(object)).toThrow(/curve 6/);
  });
});

describe("CBOR that nests", () => {
  it("refuses nine kilobytes of opening brackets instead of running out of stack", () => {
    // 0x81 is a one item array, so this is 9,216 arrays inside each other.
    const nested = new Uint8Array(9 * 1024 + 1).fill(0x81);
    nested[nested.length - 1] = 0x00;

    expect(() => decodeCbor(nested)).toThrow(CborTooDeep);
  });

  it("still reads the eight levels an attestation object could honestly use", () => {
    const eight = new Uint8Array(9);
    eight.fill(0x81, 0, 8);
    eight[8] = 0x07;

    expect(decodeCbor(eight)).toEqual([[[[[[[[7]]]]]]]]);
  });
});
