import type { Hex } from "viem";
import { toBytes32 } from "./der";

/**
 * The fixed DER header of an uncompressed P-256 SubjectPublicKeyInfo: the
 * SEQUENCE, the ecPublicKey and prime256v1 object identifiers, and the BIT
 * STRING that holds the point. WebCrypto's exportKey("spki") produces exactly
 * these 26 bytes for every P-256 key, so anything else is a different curve or
 * a different key type and must not be bound to a wallet.
 */
const P256_SPKI_HEADER = new Uint8Array([
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce,
  0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
]);

const UNCOMPRESSED_POINT = 0x04;
const POINT_BYTES = 65;
const SPKI_BYTES = P256_SPKI_HEADER.length + POINT_BYTES;

/**
 * Reads the two coordinates the registry stores out of an exported public key.
 *
 * getPublicKey() on a WebAuthn credential returns SPKI, the registry wants qx
 * and qy. The last 65 bytes are the uncompressed point, 0x04 then x then y.
 *
 * Throws when the length, the header or the 0x04 prefix is not what a P-256
 * key looks like.
 */
export function spkiToPoint(spki: Uint8Array): { qx: Hex; qy: Hex } {
  if (spki.length !== SPKI_BYTES) {
    throw new Error(`a P-256 public key is ${SPKI_BYTES} bytes in SPKI form, got ${spki.length}`);
  }

  for (let i = 0; i < P256_SPKI_HEADER.length; i += 1) {
    if (spki[i] !== P256_SPKI_HEADER[i]) {
      throw new Error("that public key is not an uncompressed P-256 key");
    }
  }

  const point = spki.subarray(P256_SPKI_HEADER.length);
  if (point[0] !== UNCOMPRESSED_POINT) {
    throw new Error("the public key point is not in uncompressed form");
  }

  return pointToCoordinates(point.subarray(1, 33), point.subarray(33, 65));
}

/** Turns the raw x and y bytes into the 32 byte words the contract stores. */
export function pointToCoordinates(x: Uint8Array, y: Uint8Array): { qx: Hex; qy: Hex } {
  if (x.length !== 32 || y.length !== 32) {
    throw new Error("a P-256 coordinate is 32 bytes");
  }
  return { qx: toBytes32(bytesToBigInt(x)), qy: toBytes32(bytesToBigInt(y)) };
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}
