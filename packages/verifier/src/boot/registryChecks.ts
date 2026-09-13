import { getAddress } from "viem";
import type { Env } from "../env.js";
import { domain } from "../generate/eip712.js";
import { AGENT_IDENTITY_REGISTRY } from "../metadata.js";
import { MONAD_CHAIN_ID, readClient } from "../reputation/registry.js";
import type { Hex } from "../types.js";

/**
 * ERC-5267. The Moolam registry inherits OpenZeppelin's EIP712, which implements this, so the
 * domain the contract will accept signatures under can be read rather than assumed.
 */
const eip712DomainAbi = [
  {
    type: "function",
    name: "eip712Domain",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "fields", type: "bytes1" },
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
      { name: "salt", type: "bytes32" },
      { name: "extensions", type: "uint256[]" },
    ],
  },
] as const;

const ownerOfAbi = [
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "owner", type: "address" }],
  },
] as const;

/**
 * Checks that the chain agrees with what this host thinks it is signing for.
 *
 * The generator agent signs EIP-712 passports offline, so a wrong registry address or a wrong
 * chain id produces signatures that look fine here and are rejected by the contract, one wasted
 * image at a time. The same goes for the agent: if the ERC-8004 identity in GENERATOR_AGENT_ID is
 * no longer owned by GENERATOR_WALLET_ADDRESS, every passport this host signs will be refused.
 * Both are read once at boot so the host fails at start instead of per request.
 *
 * The agent check is skipped when GENERATOR_WALLET_ADDRESS is unset, which is allowed: the host
 * then asks Privy for the address at the first signature and there is nothing here to compare.
 *
 * Throws one Error naming every mismatch found.
 */
export async function checkRegistry(config: Env): Promise<void> {
  const registry = getAddress(config.MOOLAM_REGISTRY_ADDRESS) as Hex;
  const client = readClient({ rpcUrl: config.MONAD_MAINNET_RPC_URL });
  const expected = domain(registry, MONAD_CHAIN_ID);
  const problems: string[] = [];

  const [, name, version, chainId, verifyingContract] = await client.readContract({
    address: registry,
    abi: eip712DomainAbi,
    functionName: "eip712Domain",
  });

  if (name !== expected.name) {
    problems.push(`the registry signs under the domain name "${name}", this host signs "${String(expected.name)}"`);
  }
  if (version !== expected.version) {
    problems.push(
      `the registry signs under domain version "${version}", this host signs "${String(expected.version)}"`,
    );
  }
  if (Number(chainId) !== MONAD_CHAIN_ID) {
    problems.push(`the registry answers for chain ${String(chainId)}, this host signs for ${MONAD_CHAIN_ID}`);
  }
  if (getAddress(verifyingContract) !== registry) {
    problems.push(
      `the registry names ${getAddress(verifyingContract)} as its verifying contract, MOOLAM_REGISTRY_ADDRESS is ${registry}`,
    );
  }

  if (config.GENERATOR_WALLET_ADDRESS !== undefined) {
    const owner = await client.readContract({
      address: AGENT_IDENTITY_REGISTRY,
      abi: ownerOfAbi,
      functionName: "ownerOf",
      args: [config.GENERATOR_AGENT_ID],
    });
    const wallet = getAddress(config.GENERATOR_WALLET_ADDRESS);
    if (getAddress(owner) !== wallet) {
      problems.push(
        `agent ${config.GENERATOR_AGENT_ID.toString()} is owned by ${getAddress(owner)}, GENERATOR_WALLET_ADDRESS is ${wallet}`,
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(`the chain does not match this host's settings: ${problems.join("; ")}`);
  }
}
