import type { Hex } from "viem";

/**
 * The order of the P-256 curve. A valid signature scalar is in 1..n-1, and the
 * contract's P256 library rejects anything at or above it outright.
 */
export const P256_ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

const HALF_ORDER = P256_ORDER >> 1n;
const SEQUENCE = 0x30;
const INTEGER = 0x02;

/**
 * Pulls r and s out of the DER signature an authenticator returns.
 *
 * WebAuthn hands back ASN.1 DER, the chain wants two 32 byte words. The parse
 * is strict on purpose: a permissive reader would accept several encodings of
 * the same signature, and the only encoding a real authenticator produces is
 * the minimal one.
 *
 * Throws when the bytes are not a DER SEQUENCE of exactly two non-negative
 * minimally encoded INTEGERs with nothing trailing.
 */
export function derToRS(sig: Uint8Array): { r: bigint; s: bigint } {
  if (sig.length < 8 || sig[0] !== SEQUENCE) {
    throw new Error("that signature is not a DER SEQUENCE");
  }

  const sequenceLength = sig[1];
  if (sequenceLength > 0x7f) {
    throw new Error("the DER length is not in the short form a P-256 signature uses");
  }
  if (sequenceLength !== sig.length - 2) {
    throw new Error(`the DER SEQUENCE claims ${sequenceLength} bytes but carries ${sig.length - 2}`);
  }

  const first = readInteger(sig, 2);
  const second = readInteger(sig, first.next);
  if (second.next !== sig.length) {
    throw new Error("the DER signature has bytes after the second INTEGER");
  }

  return { r: first.value, s: second.value };
}

/**
 * Folds a signature into the lower half of the curve order.
 *
 * Both (r, s) and (r, n - s) verify, so an authenticator may return either.
 * OpenZeppelin's P256 library refuses the upper half to keep signatures
 * unique, which makes this the difference between a transaction landing and
 * reverting with InvalidPasskeySignature.
 */
export function lowS(s: bigint): bigint {
  return s > HALF_ORDER ? P256_ORDER - s : s;
}

/** Renders a scalar as the 32 byte word the contract reads. Throws when it does not fit. */
export function toBytes32(x: bigint): Hex {
  if (x < 0n || x >= 1n << 256n) {
    throw new Error("that value does not fit in 32 bytes");
  }
  return `0x${x.toString(16).padStart(64, "0")}`;
}

function readInteger(sig: Uint8Array, offset: number): { value: bigint; next: number } {
  if (offset + 2 > sig.length || sig[offset] !== INTEGER) {
    throw new Error("expected a DER INTEGER");
  }

  const length = sig[offset + 1];
  const start = offset + 2;
  const end = start + length;
  if (length === 0 || length > 0x7f || end > sig.length) {
    throw new Error("the DER INTEGER length is out of range");
  }

  const body = sig.subarray(start, end);
  if ((body[0] & 0x80) !== 0) {
    throw new Error("a signature scalar cannot be negative");
  }
  if (body.length > 1 && body[0] === 0x00 && (body[1] & 0x80) === 0) {
    throw new Error("the DER INTEGER carries a leading zero it does not need");
  }

  let value = 0n;
  for (const byte of body) {
    value = (value << 8n) | BigInt(byte);
  }
  return { value, next: end };
}
