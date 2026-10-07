import { hexToBytes, type Hex } from "viem";
import { base64url, challengeFromDigest, type WebAuthnAuth } from "./webauthn";

/** Which of the contract's checks an assertion failed, in the order the contract runs them. */
export type AuthProblem =
  | "short-authenticator-data"
  | "wrong-relying-party"
  | "wrong-origin"
  | "wrong-type"
  | "wrong-challenge"
  | "user-not-present"
  | "user-not-verified"
  | "backup-state-without-eligibility"
  | "bad-signature";

export type AuthCheck = { ok: true } | { ok: false; problem: AuthProblem; message: string };

/**
 * The site this assertion has to belong to.
 *
 * The registry cannot see either field: it verifies the signature and nothing
 * about where the signature was made. The browser can, and an assertion made
 * for another relying party or replayed from another origin is a thing worth
 * refusing here rather than paying gas to have accepted.
 */
export interface Expected {
  /** The relying party id the credential was made under, "moolam.site" or "localhost". */
  rpId?: string;
  /** The exact origin clientDataJSON must carry, scheme, host and port. */
  origin?: string;
}

const TYPE_FIELD = '"type":"webauthn.get"';
const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_BACKUP_ELIGIBLE = 0x08;
const FLAG_BACKUP_STATE = 0x10;

/**
 * Runs the registry's own verification in the browser, before a transaction is sent.
 *
 * These are the six checks in OpenZeppelin's WebAuthn.verify with requireUV
 * true, in the same order and on the same bytes, plus the P-256 signature over
 * sha256(authenticatorData || sha256(clientDataJSON)). A failure here is a
 * failure on chain, so the studio can say which passkey or which device is
 * wrong instead of spending gas to find out.
 */
export async function checkAuth(
  auth: WebAuthnAuth,
  digest: Hex,
  qx: Hex,
  qy: Hex,
  expected: Expected = {},
): Promise<AuthCheck> {
  const authenticatorData = hexToBytes(auth.authenticatorData);
  if (authenticatorData.length < 37) {
    return fail("short-authenticator-data", "the authenticator returned fewer than 37 bytes of authenticator data");
  }

  if (expected.rpId !== undefined) {
    const wanted = new Uint8Array(await crypto.subtle.digest("SHA-256", toBuffer(new TextEncoder().encode(expected.rpId))));
    if (!sameBytes(authenticatorData.subarray(0, 32), wanted)) {
      return fail("wrong-relying-party", `this passkey was not made for ${expected.rpId}, so it belongs to another site`);
    }
  }

  const clientData = new TextEncoder().encode(auth.clientDataJSON);

  if (expected.origin !== undefined && originOf(auth.clientDataJSON) !== expected.origin) {
    return fail("wrong-origin", `this signature was made at ${String(originOf(auth.clientDataJSON))} and not at ${expected.origin}`);
  }

  const typeIndex = Number(auth.typeIndex);
  if (!matchesAt(clientData, typeIndex, TYPE_FIELD)) {
    return fail("wrong-type", "this assertion is not a webauthn.get, so the registry will not read it");
  }

  const expectedChallenge = `"challenge":"${base64url(challengeFromDigest(digest))}"`;
  if (!matchesAt(clientData, Number(auth.challengeIndex), expectedChallenge)) {
    return fail("wrong-challenge", "the passkey signed a different challenge than this passport digest");
  }

  const flags = authenticatorData[32];
  if ((flags & FLAG_USER_PRESENT) === 0) {
    return fail("user-not-present", "the device did not record a user present, so the registry refuses it");
  }
  if ((flags & FLAG_USER_VERIFIED) === 0) {
    return fail("user-not-verified", "the registry needs a biometric or a PIN on this signature, not just a touch");
  }
  if ((flags & FLAG_BACKUP_STATE) !== 0 && (flags & FLAG_BACKUP_ELIGIBLE) === 0) {
    return fail(
      "backup-state-without-eligibility",
      "the device says this passkey is backed up but not eligible for backup, which the registry rejects",
    );
  }

  const signed = new Uint8Array(authenticatorData.length + 32);
  signed.set(authenticatorData, 0);
  signed.set(new Uint8Array(await crypto.subtle.digest("SHA-256", toBuffer(clientData))), authenticatorData.length);

  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    await importPoint(qx, qy),
    toBuffer(rawSignature(auth)),
    toBuffer(signed),
  );

  return valid ? { ok: true } : fail("bad-signature", "that signature does not belong to the passkey on this wallet");
}

/** Loads a stored qx and qy as a key WebCrypto can verify with. */
export async function importPoint(qx: Hex, qy: Hex): Promise<CryptoKey> {
  const point = new Uint8Array(65);
  point[0] = 0x04;
  point.set(hexToBytes(qx, { size: 32 }), 1);
  point.set(hexToBytes(qy, { size: 32 }), 33);

  return await crypto.subtle.importKey("raw", toBuffer(point), { name: "ECDSA", namedCurve: "P-256" }, false, [
    "verify",
  ]);
}

/** The origin field of clientDataJSON, or undefined when it is not readable JSON with one. */
function originOf(clientDataJSON: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(clientDataJSON);
    const origin = (parsed as { origin?: unknown } | null)?.origin;
    return typeof origin === "string" ? origin : undefined;
  } catch {
    return undefined;
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) {
      return false;
    }
  }
  return true;
}

function rawSignature(auth: WebAuthnAuth): Uint8Array {
  const signature = new Uint8Array(64);
  signature.set(hexToBytes(auth.r, { size: 32 }), 0);
  signature.set(hexToBytes(auth.s, { size: 32 }), 32);
  return signature;
}

/**
 * Compares an ASCII field at a byte offset, which is how the contract reads
 * clientDataJSON. A short buffer is a mismatch rather than an error.
 */
function matchesAt(clientData: Uint8Array, index: number, field: string): boolean {
  if (!Number.isSafeInteger(index) || index < 0 || index + field.length > clientData.length) {
    return false;
  }
  for (let i = 0; i < field.length; i += 1) {
    if (clientData[index + i] !== field.charCodeAt(i)) {
      return false;
    }
  }
  return true;
}

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

function fail(problem: AuthProblem, message: string): AuthCheck {
  return { ok: false, problem, message };
}
