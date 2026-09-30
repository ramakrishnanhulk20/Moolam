import { isIP } from "node:net";
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, type Hex } from "viem";
import { MOOLAM_HOSTNAMES } from "./constants.js";
import { MoolamPlatformError } from "./errors.js";

/** One WebAuthn assertion, shaped exactly like OpenZeppelin's WebAuthn.WebAuthnAuth struct. */
export interface WebAuthnAuth {
  r: Hex;
  s: Hex;
  challengeIndex: bigint;
  typeIndex: bigint;
  authenticatorData: Hex;
  clientDataJSON: string;
}

/** User Present. The contract refuses an assertion without it. */
const FLAG_UP = 0x01;
/** User Verified. The registry passes requireUV true, so an assertion without it is refused. */
const FLAG_UV = 0x04;

/**
 * A server key is not synced to a cloud account, so it reports neither Backup Eligible nor Backup
 * State. The contract accepts that pairing; what it cannot do is tell this key from a phone (P15).
 */
const SERVER_FLAGS = FLAG_UP | FLAG_UV;

// The JSON is fixed, so both indexes are fixed: "{" is byte 0, the type field starts at byte 1 and
// the challenge field at byte 23. The same layout SoftwarePasskey in packages/agents uses.
const TYPE_INDEX = 1n;
const CHALLENGE_INDEX = 23n;

/**
 * Why a relying party id is not one a platform may bind its server key under, or null when it is.
 *
 * The id must already be in the one form the WHATWG URL parser gives a hostname (lower case,
 * punycode, no port, path, user or trailing dot), so the name checked is the name hashed. It must be
 * a registrable-looking domain: an IP address, "localhost" or a name under it, and a single label
 * are refused. It must not be Moolam's own hostname or any name under it (P20).
 *
 * Covers: the platform claiming Moolam's name, a local test name, and a typo that parses as another
 * host. Does not cover: whether the platform controls the domain it names. Nothing on chain reads the
 * rpId, so this is the platform's honest label for its key, not a proof.
 */
export function rpIdProblem(rpId: string): string | null {
  if (typeof rpId !== "string" || rpId.length === 0 || rpId.length > 253) {
    return "rpId must be the platform's own hostname";
  }
  let parsed: string;
  try {
    parsed = new URL(`https://${rpId}/`).hostname;
  } catch {
    return "rpId must be a hostname";
  }
  if (parsed !== rpId) {
    return `rpId must be written as the hostname "${parsed}", with nothing around it`;
  }
  if (rpId.endsWith(".")) {
    return "rpId must not end with a dot";
  }
  if (rpId.startsWith("[") || isIP(rpId) !== 0) {
    return "rpId must be a domain name, not an IP address";
  }
  if (rpId === "localhost" || rpId.endsWith(".localhost")) {
    return 'rpId must be the platform\'s public hostname, never "localhost"';
  }
  if (!rpId.includes(".")) {
    return "rpId must be a full domain name";
  }
  for (const moolam of MOOLAM_HOSTNAMES) {
    if (rpId === moolam || rpId.endsWith(`.${moolam}`)) {
      return "rpId must be the platform's own hostname, never Moolam's";
    }
  }
  return null;
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/**
 * The platform's server passkey: a P-256 key that signs the way a device passkey does, byte for
 * byte what the registry's WebAuthn check reads, bound once to the platform's wallet as its creator
 * key. The approach is SoftwarePasskey's from packages/agents.
 *
 * The private key lives in a private field and no method returns it: it comes from the caller's own
 * secret store and never leaves this object (P21).
 */
export class ServerPasskey {
  readonly qx: Hex;
  readonly qy: Hex;
  readonly rpId: string;

  readonly #privateKey: Uint8Array;
  readonly #rpIdHash: Uint8Array;

  private constructor(privateKey: Uint8Array, rpId: string) {
    const publicKey = p256.getPublicKey(privateKey, false);
    this.#privateKey = privateKey;
    this.#rpIdHash = sha256(new TextEncoder().encode(rpId));
    this.rpId = rpId;
    this.qx = bytesToHex(publicKey.slice(1, 33));
    this.qy = bytesToHex(publicKey.slice(33, 65));
  }

  /**
   * Rebuilds the passkey from the private key setupPlatform returned and the rpId it was bound under.
   *
   * Throws MoolamPlatformError "invalid-input" for a key that is not 32 bytes inside the P-256
   * range, and "invalid-rp-id" for an rpId rpIdProblem refuses.
   */
  static fromPrivateKey(privateKey: Hex, rpId: string): ServerPasskey {
    const problem = rpIdProblem(rpId);
    if (problem !== null) {
      throw new MoolamPlatformError("invalid-rp-id", problem);
    }
    let bytes: Uint8Array;
    try {
      bytes = hexToBytes(privateKey);
    } catch {
      throw new MoolamPlatformError("invalid-input", "the passkey private key must be 32 bytes of hex");
    }
    if (bytes.length !== 32 || !p256.utils.isValidSecretKey(bytes)) {
      throw new MoolamPlatformError("invalid-input", "the passkey private key must be 32 bytes inside the P-256 range");
    }
    return new ServerPasskey(bytes, rpId);
  }

  /** A fresh private key from the platform's CSPRNG, as hex, for setupPlatform to hand back once. */
  static newPrivateKey(): Hex {
    return bytesToHex(p256.utils.randomSecretKey());
  }

  /**
   * Signs a 32 byte digest as an authenticator would: the digest is the challenge inside
   * clientDataJSON, and the P-256 signature covers authenticatorData and the JSON's hash. s is kept
   * in the lower half of the order, since OpenZeppelin's P256 refuses the upper half.
   *
   * Throws MoolamPlatformError "invalid-input" for a challenge that is not 32 bytes.
   */
  sign(challenge: Hex): WebAuthnAuth {
    const challengeBytes = hexToBytes(challenge);
    if (challengeBytes.length !== 32) {
      throw new MoolamPlatformError("invalid-input", "a passkey signs a 32 byte digest");
    }

    const authenticatorData = new Uint8Array(37);
    authenticatorData.set(this.#rpIdHash, 0);
    authenticatorData[32] = SERVER_FLAGS;

    const clientDataJSON = `{"type":"webauthn.get","challenge":"${base64url(challengeBytes)}"}`;
    const message = new Uint8Array(37 + 32);
    message.set(authenticatorData, 0);
    message.set(sha256(new TextEncoder().encode(clientDataJSON)), 37);

    const signature = p256.sign(sha256(message), this.#privateKey, { prehash: false, format: "compact", lowS: true });
    return {
      r: bytesToHex(signature.slice(0, 32)),
      s: bytesToHex(signature.slice(32, 64)),
      challengeIndex: CHALLENGE_INDEX,
      typeIndex: TYPE_INDEX,
      authenticatorData: bytesToHex(authenticatorData),
      clientDataJSON,
    };
  }

  /** Nothing of the key is printed by console.log or JSON.stringify: only the public half. */
  toJSON(): Record<string, string> {
    return { qx: this.qx, qy: this.qy, rpId: this.rpId };
  }
}
