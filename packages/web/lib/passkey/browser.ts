import { bytesToHex, hexToBytes, type Hex } from "viem";
import { attestationToPoint } from "./cbor";
import { spkiToPoint } from "./spki";
import { assertionToAuth, challengeFromDigest, type WebAuthnAuth } from "./webauthn";

/**
 * The only file in lib/passkey that touches the browser. Everything it calls is
 * pure and covered by tests, so what is left here is the ceremony itself: the
 * two navigator.credentials calls, the one localStorage key, and turning a
 * DOMException into a sentence a creator can act on.
 */

/** ES256 over P-256. The registry verifies nothing else, so nothing else is offered. */
const ES256 = -7;
const RP_NAME = "Moolam";
const STORAGE_PREFIX = "moolam.passkey.";

/** Thrown when the browser has no WebAuthn at all, which is a different problem from a refusal. */
export class PasskeyUnsupported extends Error {
  constructor() {
    super("this browser has no passkey support, so a passport cannot be signed here");
    this.name = "PasskeyUnsupported";
  }
}

export interface CreatedPasskey {
  credentialId: Uint8Array;
  qx: Hex;
  qy: Hex;
}

/**
 * Creates a passkey and reads the public key the registry will store.
 *
 * getPublicKey() is asked first because it is the direct answer. Where it is
 * missing or returns nothing, the same key is dug out of the attestation
 * object, which every authenticator sends. A discoverable credential is
 * required so recovery works from the passkey alone, with no wallet to look it
 * up by, and user verification is required because the registry checks the UV
 * flag on every signature.
 */
export async function createPasskey(options: {
  rpId: string;
  wallet: Hex;
  displayName: string;
}): Promise<CreatedPasskey> {
  const credentials = credentialsApi();

  const credential = (await credentials.create({
    publicKey: {
      challenge: bufferSource(randomChallenge()),
      rp: { id: options.rpId, name: RP_NAME },
      user: { id: bufferSource(hexToBytes(options.wallet)), name: options.wallet, displayName: options.displayName },
      pubKeyCredParams: [{ type: "public-key", alg: ES256 }],
      authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
      attestation: "none",
    },
  })) as PublicKeyCredential | null;

  if (credential === null) {
    throw new Error("the browser returned no credential");
  }

  const response = credential.response as AuthenticatorAttestationResponse;
  const spki = typeof response.getPublicKey === "function" ? response.getPublicKey() : null;
  const point =
    spki === null ? attestationToPoint(new Uint8Array(response.attestationObject)) : spkiToPoint(new Uint8Array(spki));

  return { credentialId: new Uint8Array(credential.rawId), ...point };
}

/**
 * Signs a registry digest with the wallet's passkey.
 *
 * With no credential id the request carries no allowCredentials, which lets the
 * device offer whichever discoverable passkey it holds. That is the recovery
 * path: a creator on a new browser picks their passkey and the wallet it is
 * bound to is read back from the chain.
 */
export async function signDigest(options: {
  rpId: string;
  digest: Hex;
  credentialId?: Uint8Array;
}): Promise<{ auth: WebAuthnAuth; credentialId: Uint8Array }> {
  const credentials = credentialsApi();

  const credential = (await credentials.get({
    publicKey: {
      challenge: bufferSource(challengeFromDigest(options.digest)),
      rpId: options.rpId,
      userVerification: "required",
      allowCredentials:
        options.credentialId === undefined ? undefined : [{ type: "public-key", id: bufferSource(options.credentialId) }],
    },
  })) as PublicKeyCredential | null;

  if (credential === null) {
    throw new Error("the browser returned no assertion");
  }

  return {
    auth: assertionToAuth(credential.response as AuthenticatorAssertionResponse),
    credentialId: new Uint8Array(credential.rawId),
  };
}

/**
 * Remembers which credential belongs to a wallet, so the next signature does
 * not make the creator pick from a list. Losing this only costs a prompt: the
 * key itself lives on the device and the binding lives on chain.
 */
export function rememberCredential(wallet: Hex, id: Uint8Array): void {
  try {
    localStorage.setItem(storageKey(wallet), bytesToHex(id));
  } catch {
    // Private browsing and a full quota both throw here, and neither is worth stopping a signature for.
  }
}

export function recallCredential(wallet: Hex): Uint8Array | undefined {
  try {
    const stored = localStorage.getItem(storageKey(wallet));
    return stored === null ? undefined : hexToBytes(stored as Hex);
  } catch {
    return undefined;
  }
}

export interface PasskeyProblem {
  code: "cancelled" | "origin" | "unsupported" | "other";
  message: string;
}

/** Turns whatever the passkey ceremony threw into one line and a code the studio can branch on. */
export function explainPasskeyError(error: unknown): PasskeyProblem {
  if (error instanceof PasskeyUnsupported) {
    return { code: "unsupported", message: error.message };
  }

  const name = error instanceof Error ? error.name : "";

  if (name === "NotAllowedError") {
    return { code: "cancelled", message: "the passkey prompt was dismissed or timed out. Try again when ready." };
  }
  if (name === "SecurityError") {
    return {
      code: "origin",
      message: "this passkey belongs to a different site, so this page cannot use it.",
    };
  }
  if (name === "NotSupportedError") {
    return { code: "unsupported", message: "this device cannot make the kind of passkey the registry needs." };
  }

  return { code: "other", message: error instanceof Error ? error.message : String(error) };
}

function credentialsApi(): CredentialsContainer {
  if (typeof navigator === "undefined" || navigator.credentials === undefined) {
    throw new PasskeyUnsupported();
  }
  return navigator.credentials;
}

function randomChallenge(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/**
 * Copies bytes into a view the DOM types accept. viem's arrays are typed over
 * any buffer, and WebAuthn's are typed over a plain ArrayBuffer.
 */
function bufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.length));
  copy.set(bytes);
  return copy;
}

function storageKey(wallet: Hex): string {
  return `${STORAGE_PREFIX}${wallet.toLowerCase()}`;
}
