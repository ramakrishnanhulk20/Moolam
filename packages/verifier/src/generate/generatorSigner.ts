import type { AuthorizationContext } from "@privy-io/node";
import { getAddress, recoverAddress, type Hex, type TypedDataDomain } from "viem";
import { env } from "../env.js";
import { MONAD_CHAIN_ID } from "../reputation/registry.js";
import { domain, PASSPORT_TYPES, passportDigest, type PassportInput } from "./eip712.js";
import { privy } from "./privy.js";

/** eth_signTypedData_v4 wants the domain's own type listed, so the fields the registry uses are named here. */
const EIP712_DOMAIN_TYPE = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
];

export interface GeneratorWallet {
  id: string;
  address: Hex;
}

let wallet: GeneratorWallet | undefined;

/**
 * The Privy server wallet that owns the generator agent's ERC-8004 identity.
 *
 * The id is the handle Privy signs with and it has to be configured. The address is only used to
 * check the signature that comes back, so it is read from Privy when the environment does not name
 * it, and the answer is kept for the life of the process. A configured address that disagrees with
 * Privy's is a refusal rather than a warning: signing with the wrong wallet produces a passport
 * the registry rejects.
 *
 * Throws when GENERATOR_WALLET_ID is missing, when Privy cannot be reached, and on a mismatch.
 */
export async function generatorWallet(): Promise<GeneratorWallet> {
  if (wallet !== undefined) return wallet;

  const id = env.GENERATOR_WALLET_ID;
  if (id === undefined) {
    throw new Error(
      "GENERATOR_WALLET_ID is missing, so this host cannot sign as the generator agent. It is the Privy wallet id recorded in packages/agents/.moolam/wallets.json.",
    );
  }

  const live = getAddress((await privy().wallets().get(id)).address as Hex);
  const configured = env.GENERATOR_WALLET_ADDRESS;
  if (configured !== undefined && getAddress(configured as Hex) !== live) {
    throw new Error(
      `GENERATOR_WALLET_ADDRESS is ${configured}, but Privy says wallet ${id} is ${live}.`,
    );
  }

  wallet = { id, address: live };
  return wallet;
}

/** The EIP-712 domain of the deployed Moolam registry on Monad mainnet. */
export function generatorDomain(): TypedDataDomain {
  return domain(env.MOOLAM_REGISTRY_ADDRESS as Hex, MONAD_CHAIN_ID);
}

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
  dom: TypedDataDomain,
  context: AuthorizationContext,
): Promise<Hex> {
  const response = await privy()
    .wallets()
    .ethereum()
    .signTypedData(walletId, {
      params: {
        typed_data: {
          domain: {
            name: dom.name,
            version: dom.version,
            chainId: Number(dom.chainId),
            verifyingContract: dom.verifyingContract,
          },
          types: { EIP712Domain: EIP712_DOMAIN_TYPE, Passport: [...PASSPORT_TYPES.Passport] },
          primary_type: "Passport",
          message: jsonSafe(input),
        },
      },
      authorization_context: context,
    });

  const signature = response.signature as Hex;
  const digest = passportDigest(input, dom);
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
