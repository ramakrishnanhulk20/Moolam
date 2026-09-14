import { createPublicClient, http, type Abi, type Hex } from "viem";
import { monad } from "viem/chains";
import deployment from "../../../contracts/deployments/monad-mainnet.json";
import registryAbiJson from "../../../contracts/abi/MoolamRegistry.json";
import policyAbiJson from "../../../contracts/abi/VerifierPolicy.json";
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

/**
 * How long a read of something that moves with the registry is held.
 *
 * The index itself only catches up with the chain every minute or so, so paying
 * for the same query more often than this buys a visitor nothing and costs them
 * the wait. Every page that shows live figures is held for exactly this long.
 */
export const HOLD_SECONDS = 60;

/**
 * How long a pinned metadata document is held. It is content addressed, so the
 * same URI can never come back with different words or a different picture.
 */
export const METADATA_HOLD_SECONDS = 86_400;

/**
 * The names on the held reads, so one kind can be dropped on its own later
 * without throwing away everything else the app has cached.
 */
export const CACHE_TAGS = {
  index: "moolam-index",
  chain: "moolam-chain",
  metadata: "moolam-metadata",
} as const;

export const registryAbi = registryAbiJson as Abi;

/**
 * The policy contract's ABI. The registry is immutable, so the bond, the
 * resolver and the treasury are read from here rather than from the registry
 * itself: these are the three settings that can still change.
 */
export const policyAbi = policyAbiJson as Abi;

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

/**
 * Where ipfs:// is read through. The shared gateway.pinata.cloud is the
 * fallback and it rate limits hard on a page full of thumbnails, so
 * NEXT_PUBLIC_IPFS_GATEWAY points at the account's own gateway. A missing
 * trailing slash is added here rather than left to break every URL.
 */
const IPFS_GATEWAY = publicEnv.ipfsGateway.endsWith("/") ? publicEnv.ipfsGateway : `${publicEnv.ipfsGateway}/`;

/**
 * Turns a stored URI into something a browser can open. ipfs:// is rewritten to
 * the gateway; anything else is left alone so a bad value is visible rather
 * than silently hidden.
 */
export function gatewayUrl(uri: string): string {
  return uri.startsWith("ipfs://") ? `${IPFS_GATEWAY}${uri.slice("ipfs://".length)}` : uri;
}
