import { bytesToHex, hexToBytes, type Hex } from "viem";
import { derToRS, lowS, toBytes32 } from "./der";

/**
 * One WebAuthn assertion in the shape OpenZeppelin's WebAuthn.WebAuthnAuth
 * struct expects, field for field and in the same order.
 *
 * The two index fields say where "type" and "challenge" begin inside
 * clientDataJSON. They are how the contract reads those fields without parsing
 * JSON, and they are counted in bytes, not in characters.
 */
export interface WebAuthnAuth {
  r: Hex;
  s: Hex;
  challengeIndex: bigint;
  typeIndex: bigint;
  authenticatorData: Hex;
  clientDataJSON: string;
}

export const TYPE_MARKER = '"type":';
export const CHALLENGE_MARKER = '"challenge":';

/**
 * Turns what navigator.credentials.get returned into the struct the registry
 * verifies.
 *
 * clientDataJSON is kept exactly as the authenticator wrote it, whitespace and
 * field order and all, because the contract hashes the string it is given and
 * any reformatting would change that hash.
 *
 * Throws when either marker is missing from clientDataJSON or when the
 * signature is not valid DER.
 */
export function assertionToAuth(response: {
  authenticatorData: ArrayBuffer;
  clientDataJSON: ArrayBuffer;
  signature: ArrayBuffer;
}): WebAuthnAuth {
  const clientDataJSON = new TextDecoder("utf-8", { fatal: true }).decode(response.clientDataJSON);

  const { r, s } = derToRS(new Uint8Array(response.signature));

  return {
    r: toBytes32(r),
    s: toBytes32(lowS(s)),
    challengeIndex: BigInt(markerIndex(clientDataJSON, CHALLENGE_MARKER)),
    typeIndex: BigInt(markerIndex(clientDataJSON, TYPE_MARKER)),
    authenticatorData: bytesToHex(new Uint8Array(response.authenticatorData)),
    clientDataJSON,
  };
}

/** The 32 raw bytes of an EIP-712 digest, which is what the passkey signs as its challenge. */
export function challengeFromDigest(digest: Hex): Uint8Array {
  const bytes = hexToBytes(digest);
  if (bytes.length !== 32) {
    throw new Error(`a challenge is the 32 byte digest, got ${bytes.length} bytes`);
  }
  return bytes;
}

/** base64url with no padding, the encoding the contract rebuilds the challenge in. */
export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Where a marker starts, counted in bytes.
 *
 * indexOf counts UTF-16 units and the contract counts bytes. They only differ
 * when something before the marker is outside ASCII, which an origin with a
 * non-Latin host name could be, so the prefix is re-measured as UTF-8.
 */
function markerIndex(clientDataJSON: string, marker: string): number {
  const at = clientDataJSON.indexOf(marker);
  if (at < 0) {
    throw new Error(`clientDataJSON has no ${marker} field, so the contract could not read it`);
  }
  return new TextEncoder().encode(clientDataJSON.slice(0, at)).length;
}
