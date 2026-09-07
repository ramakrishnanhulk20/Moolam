import { hashTypedData, type Hex, type TypedDataDomain } from "viem";

/**
 * How the image came to exist, matching the Kind enum in IMoolamRegistry.sol.
 */
export const Kind = { Generated: 0, Captured: 1, Edited: 2 } as const;

export interface PassportInput {
  exactHash: Hex;
  parentId: Hex;
  creator: Hex;
  generatorAgentId: bigint;
  phash: bigint;
  blockhash256: Hex;
  manifestHash: Hex;
  kind: 0 | 1 | 2;
  fingerprintVersion: number;
  metadataURI: string;
  deadline: bigint;
}

/**
 * Field order here is load bearing: it is what produces the type string, and it must match
 * PASSPORT_TYPEHASH in MoolamRegistry.sol character for character.
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

/**
 * The EIP-712 domain the registry builds in its constructor: EIP712("Moolam", "1"), bound to
 * the chain it sits on and to its own address.
 */
export function domain(registry: Hex, chainId: number): TypedDataDomain {
  return { name: "Moolam", version: "1", chainId, verifyingContract: registry };
}

/**
 * The 32 bytes the creator's passkey and the generator agent both sign. This is also the
 * WebAuthn challenge, so it is what ends up base64url encoded inside clientDataJSON.
 */
export function passportDigest(input: PassportInput, dom: TypedDataDomain): Hex {
  return hashTypedData({
    domain: dom,
    types: PASSPORT_TYPES,
    primaryType: "Passport",
    message: input,
  });
}

/**
 * The 32 bytes a passkey signs to bind itself to a wallet. The nonce makes an old bind
 * signature useless once it has been spent.
 */
export function bindDigest(
  wallet: Hex,
  qx: Hex,
  qy: Hex,
  nonce: bigint,
  dom: TypedDataDomain,
): Hex {
  return hashTypedData({
    domain: dom,
    types: BIND_TYPES,
    primaryType: "Bind",
    message: { wallet, qx, qy, nonce },
  });
}
