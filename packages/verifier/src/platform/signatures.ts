import { getAddress, hashTypedData, hexToBytes, recoverAddress, type Address, type Hex } from "viem";
import { ONBOARDING_DOMAIN } from "../platforms/platforms.js";

/** The two ways a platform may register a picture, as the PlatformPrepare message numbers them. */
export const MODE = { platform: 0, cosign: 1 } as const;

export type PlatformMode = keyof typeof MODE;

/**
 * The domain the platform's agent signs a PlatformPrepare in: the same one the onboarding
 * signatures use, Moolam platform version 1 on chain 143, so a platform's tools hold one domain.
 */
export const PREPARE_DOMAIN = ONBOARDING_DOMAIN;

/** Field order is load bearing: it produces the type string every signer hashes. */
export const PREPARE_TYPES = {
  PlatformPrepare: [
    { name: "mode", type: "uint8" },
    { name: "pictureHash", type: "bytes32" },
    { name: "platformId", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
  ],
} as const;

/**
 * How far from chain time a PlatformPrepare may be issued: ten minutes back. A nonce is remembered
 * for this long after its issuedAt, which is exactly as long as a replay could still pass the window.
 */
export const PREPARE_WINDOW_SECONDS = 600n;

/**
 * How far ahead of the latest block a PlatformPrepare may be dated. A platform's clock and a block a
 * few seconds old disagree a little; a message dated further ahead would stretch its own window.
 */
export const PREPARE_AHEAD_SECONDS = 60n;

export interface PlatformPrepareMessage {
  mode: number;
  pictureHash: Hex;
  platformId: Hex;
  nonce: Hex;
  issuedAt: bigint;
}

/** The typed data a platform's agent owner signs, ready for signTypedData. */
export function prepareTypedData(message: PlatformPrepareMessage) {
  return {
    domain: PREPARE_DOMAIN,
    types: PREPARE_TYPES,
    primaryType: "PlatformPrepare" as const,
    message,
  };
}

/** The 32 bytes a PlatformPrepare signature covers. */
export function prepareDigest(message: PlatformPrepareMessage): Hex {
  return hashTypedData(prepareTypedData(message));
}

/** Half the secp256k1 group order. OpenZeppelin's ECDSA refuses an s above it. */
const HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/**
 * The address a 65 byte signature recovers to over `digest`, by the rules OpenZeppelin's
 * ECDSA.tryRecover applies in MoolamRegistry._checkGenerator: exactly 65 bytes, v of 27 or 28, and
 * s in the lower half of the order, so a signature the registry would refuse is refused here too,
 * and one signature has one form. Returns undefined for anything that does not recover.
 */
export async function recoverLikeRegistry(digest: Hex, signature: string): Promise<Address | undefined> {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    return undefined;
  }
  const bytes = hexToBytes(signature as Hex);
  const s = BigInt(`0x${Buffer.from(bytes.subarray(32, 64)).toString("hex")}`);
  const v = bytes[64];
  if (s === 0n || s > HALF_ORDER || (v !== 27 && v !== 28)) {
    return undefined;
  }
  try {
    return getAddress(await recoverAddress({ hash: digest, signature: signature as Hex }));
  } catch {
    return undefined;
  }
}

/** Whether `signature` over `digest` recovers to `expected`, compared after getAddress on both sides. */
export async function signedByAddress(digest: Hex, signature: string, expected: string): Promise<boolean> {
  const recovered = await recoverLikeRegistry(digest, signature);
  if (recovered === undefined) {
    return false;
  }
  try {
    return recovered === getAddress(expected);
  } catch {
    return false;
  }
}

/** Why a PlatformPrepare is refused, or null when its time is inside the window. */
export function issuedAtProblem(issuedAt: bigint, chainNow: bigint): string | null {
  if (issuedAt + PREPARE_WINDOW_SECONDS < chainNow) {
    return "issuedAt is more than ten minutes before chain time";
  }
  if (issuedAt > chainNow + PREPARE_AHEAD_SECONDS) {
    return "issuedAt is ahead of chain time";
  }
  return null;
}
