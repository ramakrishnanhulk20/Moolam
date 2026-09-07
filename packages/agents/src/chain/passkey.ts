import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, type Hex } from "viem";

/**
 * One WebAuthn assertion, shaped exactly like OpenZeppelin's WebAuthn.WebAuthnAuth struct.
 * The two index fields say where "type" and "challenge" start inside clientDataJSON, which is
 * how the contract reads those fields without parsing JSON.
 */
export interface WebAuthnAuth {
  authenticatorData: Hex;
  clientDataJSON: string;
  challengeIndex: bigint;
  typeIndex: bigint;
  r: Hex;
  s: Hex;
}

/** User Present. The contract refuses an assertion without it. */
const FLAG_UP = 0x01;
/** User Verified: a biometric or a PIN. The registry passes requireUV true, so this is required. */
const FLAG_UV = 0x04;
/** Backup Eligible and Backup State, what a synced platform passkey reports. */
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;

const DEFAULT_FLAGS = FLAG_UP | FLAG_UV | FLAG_BE | FLAG_BS;

// The JSON below is fixed, so both indexes are fixed. "{" is byte 0, the 21 byte type field runs
// from byte 1, a comma sits at byte 22, and the challenge field opens at byte 23.
const TYPE_INDEX = 1n;
const CHALLENGE_INDEX = 23n;

/** The relying party a local Moolam session runs under. The contract never checks it. */
const DEFAULT_RP_ID = "localhost";

export interface PasskeyOptions {
  /** The relying party id hashed into authenticatorData. */
  rpId?: string;
  /** Override the authenticator flags byte, for tests that need a device that skipped the touch. */
  flags?: number;
  /** The authenticator's signature counter. Platform passkeys report zero. */
  signCount?: number;
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/**
 * A P-256 key that signs the same way a device passkey does.
 *
 * The signature format, the authenticator data and the client data JSON are byte for byte what a
 * browser hands back from navigator.credentials.get, so the contract cannot tell the difference.
 * What is missing is the hardware: the key sits in memory instead of a secure enclave, and no
 * human touched anything. Use this for agents, tests and scripts, never for a real user.
 */
export class SoftwarePasskey {
  readonly qx: Hex;
  readonly qy: Hex;

  readonly #privateKey: Uint8Array;
  readonly #rpIdHash: Uint8Array;
  readonly #flags: number;
  readonly #signCount: number;

  private constructor(privateKey: Uint8Array, options: PasskeyOptions) {
    const publicKey = p256.getPublicKey(privateKey, false);
    this.#privateKey = privateKey;
    this.#rpIdHash = sha256(new TextEncoder().encode(options.rpId ?? DEFAULT_RP_ID));
    this.#flags = options.flags ?? DEFAULT_FLAGS;
    this.#signCount = options.signCount ?? 0;
    this.qx = bytesToHex(publicKey.slice(1, 33));
    this.qy = bytesToHex(publicKey.slice(33, 65));
  }

  /** Builds a passkey from a 32 byte P-256 private key. Throws when the key is out of range. */
  static fromPrivateKey(privateKey: Hex, options: PasskeyOptions = {}): SoftwarePasskey {
    const bytes = hexToBytes(privateKey);
    if (bytes.length !== 32) {
      throw new Error(`A P-256 private key is 32 bytes, got ${bytes.length}.`);
    }
    if (!p256.utils.isValidSecretKey(bytes)) {
      throw new Error("That private key is outside the valid P-256 range.");
    }
    return new SoftwarePasskey(bytes, options);
  }

  /** Builds a passkey from a fresh random key. */
  static random(options: PasskeyOptions = {}): SoftwarePasskey {
    return new SoftwarePasskey(p256.utils.randomSecretKey(), options);
  }

  /**
   * Signs a 32 byte digest the way an authenticator would.
   *
   * The digest goes into clientDataJSON base64url encoded as the challenge, the JSON is hashed
   * into authenticatorData, and the P-256 signature covers that. s is normalised into the lower
   * half of the curve order because OpenZeppelin's P256 library rejects the upper half outright.
   */
  sign(challenge: Hex): WebAuthnAuth {
    const challengeBytes = hexToBytes(challenge);
    if (challengeBytes.length !== 32) {
      throw new Error(`The challenge is the 32 byte digest, got ${challengeBytes.length} bytes.`);
    }

    const authenticatorData = new Uint8Array(37);
    authenticatorData.set(this.#rpIdHash, 0);
    authenticatorData[32] = this.#flags;
    new DataView(authenticatorData.buffer).setUint32(33, this.#signCount, false);

    const clientDataJSON = `{"type":"webauthn.get","challenge":"${base64url(challengeBytes)}"}`;

    const message = new Uint8Array(37 + 32);
    message.set(authenticatorData, 0);
    message.set(sha256(new TextEncoder().encode(clientDataJSON)), 37);

    const signature = p256.sign(sha256(message), this.#privateKey, {
      prehash: false,
      format: "compact",
      lowS: true,
    });

    return {
      authenticatorData: bytesToHex(authenticatorData),
      clientDataJSON,
      challengeIndex: CHALLENGE_INDEX,
      typeIndex: TYPE_INDEX,
      r: bytesToHex(signature.slice(0, 32)),
      s: bytesToHex(signature.slice(32, 64)),
    };
  }
}
