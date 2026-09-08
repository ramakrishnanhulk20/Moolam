import type { AuthorizationContext } from "@privy-io/node";
import { getAddress, recoverAddress, type Hex, type TypedDataDomain } from "viem";
import { PASSPORT_TYPES, passportDigest, type PassportInput } from "../chain/eip712.js";
import { privy } from "./client.js";

/** eth_signTypedData_v4 wants the domain's own type listed, so the fields the registry uses are named here. */
const EIP712_DOMAIN_TYPE = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
];

/**
 * The generator agent signs a passport with the wallet that owns its ERC-8004 identity, through
 * Privy's typed data signing.
 *
 * This is the same EIP-712 struct the creator's passkey signs, so both signatures cover identical
 * bytes and the registry recovers the agent owner from this one. The signature is checked here
 * against the digest the contract will build before it is ever sent, because a mismatch on chain
 * costs gas and comes back as an opaque InvalidGeneratorSignature.
 *
 * Throws when Privy refuses the signing request, and when the recovered address is not the
 * agent's wallet.
 */
export async function signPassportAsGenerator(
  walletId: string,
  walletAddress: Hex,
  input: PassportInput,
  domain: TypedDataDomain,
  context: AuthorizationContext,
): Promise<Hex> {
  const response = await privy()
    .wallets()
    .ethereum()
    .signTypedData(walletId, {
      params: {
        typed_data: {
          domain: {
            name: domain.name,
            version: domain.version,
            chainId: Number(domain.chainId),
            verifyingContract: domain.verifyingContract,
          },
          types: { EIP712Domain: EIP712_DOMAIN_TYPE, Passport: [...PASSPORT_TYPES.Passport] },
          primary_type: "Passport",
          message: jsonSafe(input),
        },
      },
      authorization_context: context,
    });

  const signature = response.signature as Hex;
  const digest = passportDigest(input, domain);
  const recovered = await recoverAddress({ hash: digest, signature });
  if (getAddress(recovered) !== getAddress(walletAddress)) {
    throw new Error(
      `Privy signed the passport with ${recovered}, but the agent's wallet is ${walletAddress}.`,
    );
  }
  return signature;
}

/**
 * The passport as JSON the Privy API accepts. The numeric fields are 64 and 256 bit values that
 * do not survive JSON as numbers, so they travel as decimal strings, which is what EIP-712
 * encoding expects to read.
 */
function jsonSafe(input: PassportInput): Record<string, unknown> {
  return {
    exactHash: input.exactHash,
    parentId: input.parentId,
    creator: input.creator,
    generatorAgentId: input.generatorAgentId.toString(),
    phash: input.phash.toString(),
    blockhash256: input.blockhash256,
    manifestHash: input.manifestHash,
    kind: input.kind,
    fingerprintVersion: input.fingerprintVersion,
    metadataURI: input.metadataURI,
    deadline: input.deadline.toString(),
  };
}
