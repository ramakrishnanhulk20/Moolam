import { createPublicClient, http, type Abi, type Hex } from "viem";
import { monad } from "viem/chains";
import deployment from "../../../contracts/deployments/monad-mainnet.json";
import registryAbiJson from "../../../contracts/abi/MoolamRegistry.json";
import { publicEnv } from "@/lib/env";

/**
 * The deployed addresses come from the file the deploy script writes, so the
 * app can never point at an address the contracts were not deployed to.
 */
export const addresses = {
  registry: deployment.registry as Hex,
  policy: deployment.policy as Hex,
  receiver: deployment.receiver as Hex,
  agentIdentity: deployment.agentIdentity as Hex,
} as const;

/** The block the registry was deployed in: nothing it emitted exists before it. */
export const DEPLOY_BLOCK = BigInt(deployment.block);
export const CHAIN_ID = deployment.chainId;
export const DEMO_AGENT_ID = BigInt(deployment.demoAgentId);
export const MONAD_EXPLORER = "https://monadvision.com";

/** The canonical ERC-8004 reputation registry on Monad mainnet. */
export const REPUTATION_REGISTRY = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63" as Hex;

export const registryAbi = registryAbiJson as Abi;

/**
 * Reads only, and only from the server. The RPC URL is public, but keeping the
 * reads on this side means one endpoint answers for every visitor rather than
 * every browser opening its own connection to the chain.
 */
export const chain = createPublicClient({
  chain: monad,
  transport: http(publicEnv.monadRpcUrl, { batch: true, timeout: 15_000 }),
});

/** Turns any thrown value into one line a person can act on. */
export function reason(error: unknown): string {
  if (error instanceof Error) {
    return error.message.split("\n")[0];
  }
  return String(error);
}

export function shortHex(value: string, lead = 6, tail = 4): string {
  return value.length <= lead + tail + 2 ? value : `${value.slice(0, lead + 2)}…${value.slice(-tail)}`;
}

const IPFS_GATEWAY = "https://gateway.pinata.cloud/ipfs/";

/**
 * Turns a stored URI into something a browser can open. ipfs:// is rewritten to
 * the same public gateway the verifier reads through; anything else is left
 * alone so a bad value is visible rather than silently hidden.
 */
export function gatewayUrl(uri: string): string {
  return uri.startsWith("ipfs://") ? `${IPFS_GATEWAY}${uri.slice("ipfs://".length)}` : uri;
}
