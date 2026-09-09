import type { Hex } from "viem";

/**
 * Byte-level builders the passkey tests share: a DER encoder, a small CBOR
 * encoder, and a WebCrypto key that signs assertions the way an authenticator
 * would. Nothing here is shipped, it exists so the tests can feed the library
 * the exact bytes a browser and an authenticator produce.
 */

export function encodeDerSignature(r: bigint, s: bigint): Uint8Array {
  const body = [...encodeDerInteger(r), ...encodeDerInteger(s)];
  return new Uint8Array([0x30, body.length, ...body]);
}

export function encodeDerInteger(value: bigint): number[] {
  let hex = value.toString(16);
  if (hex.length % 2 === 1) {
    hex = `0${hex}`;
  }
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(Number.parseInt(hex.slice(i, i + 2), 16));
  }
  if ((bytes[0] & 0x80) !== 0) {
    bytes.unshift(0x00);
  }
  return [0x02, bytes.length, ...bytes];
}

export function rawSignatureToDer(raw: Uint8Array): Uint8Array {
  if (raw.length !== 64) {
    throw new Error(`a raw P-256 signature is 64 bytes, got ${raw.length}`);
  }
  return encodeDerSignature(bytesToBigInt(raw.subarray(0, 32)), bytesToBigInt(raw.subarray(32, 64)));
}

export function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}

export type CborValue = number | string | Uint8Array | CborValue[] | Map<number | string, CborValue>;

export function cborEncode(value: CborValue): Uint8Array {
  if (typeof value === "number") {
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  }
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    return concat(head(3, bytes.length), bytes);
  }
  if (value instanceof Uint8Array) {
    return concat(head(2, value.length), value);
  }
  if (Array.isArray(value)) {
    return concat(head(4, value.length), ...value.map(cborEncode));
  }
  const parts: Uint8Array[] = [head(5, value.size)];
  for (const [key, entry] of value) {
    parts.push(cborEncode(key), cborEncode(entry));
  }
  return concat(...parts);
}

function head(major: number, argument: number): Uint8Array {
  const tag = major << 5;
  if (argument < 24) {
    return new Uint8Array([tag | argument]);
  }
  if (argument < 0x100) {
    return new Uint8Array([tag | 24, argument]);
  }
  if (argument < 0x10000) {
    return new Uint8Array([tag | 25, argument >> 8, argument & 0xff]);
  }
  return new Uint8Array([tag | 26, argument >>> 24, (argument >> 16) & 0xff, (argument >> 8) & 0xff, argument & 0xff]);
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer));
}

export function base64urlOf(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export async function makeP256Key(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
}

export async function exportPoint(key: CryptoKey): Promise<{ qx: Hex; qy: Hex }> {
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));
  return {
    qx: `0x${Buffer.from(raw.subarray(1, 33)).toString("hex")}`,
    qy: `0x${Buffer.from(raw.subarray(33, 65)).toString("hex")}`,
  };
}

export interface AssertionOptions {
  /** The authenticator flags byte. 0x05 is User Present plus User Verified. */
  flags?: number;
  origin?: string;
  /** Overrides the challenge written into clientDataJSON, for the wrong-challenge case. */
  challengeText?: string;
}

/**
 * Signs an assertion the way a platform authenticator does: the challenge goes
 * into clientDataJSON base64url encoded, the JSON is hashed into
 * authenticatorData, and the P-256 signature covers that.
 */
export async function buildAssertion(
  key: CryptoKeyPair,
  challenge: Uint8Array,
  options: AssertionOptions = {},
): Promise<{ authenticatorData: ArrayBuffer; clientDataJSON: ArrayBuffer; signature: ArrayBuffer }> {
  const authenticatorData = new Uint8Array(37);
  authenticatorData.set(await sha256(new TextEncoder().encode("localhost")), 0);
  authenticatorData[32] = options.flags ?? 0x05;

  const origin = options.origin ?? "http://localhost:3210";
  const challengeText = options.challengeText ?? base64urlOf(challenge);
  const clientDataJSON = new TextEncoder().encode(
    `{"type":"webauthn.get","challenge":"${challengeText}","origin":"${origin}","crossOrigin":false}`,
  );

  const signed = concat(authenticatorData, await sha256(clientDataJSON));
  const raw = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key.privateKey,
      signed as unknown as ArrayBuffer,
    ),
  );

  return {
    authenticatorData: toArrayBuffer(authenticatorData),
    clientDataJSON: toArrayBuffer(clientDataJSON),
    signature: toArrayBuffer(rawSignatureToDer(raw)),
  };
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}
