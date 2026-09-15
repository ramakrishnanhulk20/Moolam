import { hashTypedData, type Hex, type TypedDataDomain } from "viem";
import { CHAIN_ID, addresses } from "./client";
import type { PassportInput } from "./calldata";

/**
 * The two digests a passkey signs, built here in the browser.
 *
 * They were read from the registry before, one RPC call each, which meant the
 * bytes a person is about to sign were whatever an RPC endpoint said they
 * were. Building them locally and then comparing against the contract's own
 * answer is the honest order: the browser knows what it signed, and a
 * disagreement is caught before the passkey is touched rather than after.
 *
 * The field lists are copied from packages/verifier/src/generate/eip712.ts on
 * purpose. They are the type string the registry hashed into its constructor,
 * so a field out of place here is a signature the contract will not recognise.
 */

const PASSPORT_TYPES = {
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

const BIND_TYPES = {
  Bind: [
    { name: "wallet", type: "address" },
    { name: "qx", type: "bytes32" },
    { name: "qy", type: "bytes32" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

/** The domain the registry built in its constructor: EIP712("Moolam", "1") on this chain, at its own address. */
export const DOMAIN: TypedDataDomain = {
  name: "Moolam",
  version: "1",
  chainId: CHAIN_ID,
  verifyingContract: addresses.registry,
};

/** The 32 bytes a creator's passkey signs to register a passport. */
export function localPassportDigest(input: PassportInput): Hex {
  return hashTypedData({ domain: DOMAIN, types: PASSPORT_TYPES, primaryType: "Passport", message: input });
}

/** The 32 bytes a passkey signs to bind itself to a wallet. The nonce kills an old bind signature once spent. */
export function localBindDigest(wallet: Hex, qx: Hex, qy: Hex, nonce: bigint): Hex {
  return hashTypedData({
    domain: DOMAIN,
    types: BIND_TYPES,
    primaryType: "Bind",
    message: { wallet, qx, qy, nonce },
  });
}

/**
 * The local digest and the contract's disagree, which means the two are not
 * describing the same transaction and nothing may be signed.
 */
export class DigestMismatch extends Error {
  readonly local: Hex;
  readonly fromChain: Hex;

  constructor(local: Hex, fromChain: Hex) {
    super(
      `this browser built the digest ${local} and the registry answered ${fromChain}, so nothing here may be signed`,
    );
    this.name = "DigestMismatch";
    this.local = local;
    this.fromChain = fromChain;
  }
}

/** Stops a flow before the passkey prompt when the two digests are not the same bytes. */
export function assertDigestMatches(local: Hex, fromChain: Hex): void {
  if (local.toLowerCase() !== fromChain.toLowerCase()) {
    throw new DigestMismatch(local, fromChain);
  }
}
