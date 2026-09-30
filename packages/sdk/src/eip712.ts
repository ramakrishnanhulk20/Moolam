import { hashTypedData, type Address, type Hex } from "viem";
import { MONAD_CHAIN_ID, MOOLAM_REGISTRY } from "./constants.js";

/** The struct the registry's hashPassport reads. Matches PassportInput in IMoolamRegistry.sol. */
export interface PassportInput {
  exactHash: Hex;
  parentId: Hex;
  creator: Address;
  generatorAgentId: bigint;
  phash: bigint;
  blockhash256: Hex;
  manifestHash: Hex;
  kind: number;
  fingerprintVersion: number;
  metadataURI: string;
  deadline: bigint;
}

/**
 * Field order is load bearing: it produces the type string, which must equal PASSPORT_TYPEHASH in
 * MoolamRegistry.sol character for character.
 */
export const PASSPORT_TYPES = {
  Passport: [
    { name: "exactHash", type: "bytes32" },
    { name: "parentId", type: "bytes32" },
    { name: "creator", type: "address" },
    { name: "generatorAgentId", type: "uint256" },
    { name: "phash", type: "uint64" },
    { name: "blockhash256", type: "bytes32" },
    { name: "manifestHash", type: "bytes32" },
    { name: "kind", type: "uint8" },
    { name: "fingerprintVersion", type: "uint8" },
    { name: "metadataURI", type: "string" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

export const BIND_TYPES = {
  Bind: [
    { name: "wallet", type: "address" },
    { name: "qx", type: "bytes32" },
    { name: "qy", type: "bytes32" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

/** The domain the registry builds in its constructor: EIP712("Moolam", "1") on Monad, at its own address. */
export const REGISTRY_DOMAIN = {
  name: "Moolam",
  version: "1",
  chainId: MONAD_CHAIN_ID,
  verifyingContract: MOOLAM_REGISTRY,
} as const;

/** The domain a platform's agent owner signs a PlatformPrepare in, the one the verify service checks. */
export const PREPARE_DOMAIN = { name: "Moolam platform", version: "1", chainId: MONAD_CHAIN_ID } as const;

/** Field order is load bearing: it is the verify service's own PlatformPrepare type string. */
export const PREPARE_TYPES = {
  PlatformPrepare: [
    { name: "mode", type: "uint8" },
    { name: "pictureHash", type: "bytes32" },
    { name: "platformId", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
  ],
} as const;

/** The two ways a platform registers a picture, numbered as the PlatformPrepare message numbers them. */
export const MODE = { platform: 0, cosign: 1 } as const;

export type PlatformMode = keyof typeof MODE;

export interface PlatformPrepareMessage {
  mode: number;
  pictureHash: Hex;
  platformId: Hex;
  nonce: Hex;
  issuedAt: bigint;
}

/** The passport as typed data, ready for an account's signTypedData. */
export function passportTypedData(input: PassportInput) {
  return { domain: REGISTRY_DOMAIN, types: PASSPORT_TYPES, primaryType: "Passport" as const, message: input };
}

/** The 32 bytes the creator's passkey and the agent's owner both sign: the registry's hashPassport. */
export function passportDigest(input: PassportInput): Hex {
  return hashTypedData(passportTypedData(input));
}

/** The 32 bytes a passkey signs to bind itself to a wallet: the registry's hashBind. */
export function bindDigest(wallet: Address, qx: Hex, qy: Hex, nonce: bigint): Hex {
  return hashTypedData({
    domain: REGISTRY_DOMAIN,
    types: BIND_TYPES,
    primaryType: "Bind",
    message: { wallet, qx, qy, nonce },
  });
}

/** The PlatformPrepare as typed data, ready for the agent owner's signTypedData. */
export function prepareTypedData(message: PlatformPrepareMessage) {
  return { domain: PREPARE_DOMAIN, types: PREPARE_TYPES, primaryType: "PlatformPrepare" as const, message };
}

/** The 32 bytes a PlatformPrepare signature covers. */
export function prepareDigest(message: PlatformPrepareMessage): Hex {
  return hashTypedData(prepareTypedData(message));
}
