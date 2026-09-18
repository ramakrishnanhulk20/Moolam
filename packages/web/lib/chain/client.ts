import { createPublicClient, fallback, http, type Abi, type Hex } from "viem";
import { monad } from "viem/chains";
import deployment from "../../../contracts/deployments/monad-mainnet.json";
import registryAbiJson from "../../../contracts/abi/MoolamRegistry.json";
import policyAbiJson from "../../../contracts/abi/VerifierPolicy.json";
import consentAbiJson from "../../../contracts/abi/MoolamConsent.json";
import { publicEnv, serverRpcUrl } from "@/lib/env";

/**
 * The deployed addresses come from the file the deploy script writes, so the
 * app can never point at an address the contracts were not deployed to.
 */
export const addresses = {
  registry: deployment.registry as Hex,
  policy: deployment.policy as Hex,
  receiver: deployment.receiver as Hex,
  agentIdentity: deployment.agentIdentity as Hex,
  /** Where a passport holder's statement on AI use is written and read back. */
  consent: deployment.consent as Hex,
  /**
   * The two addresses a CRE report can arrive through. The receiver is pointed
   * at the live network forwarder and was pointed at the simulation one for the
   * broadcast runs that wrote the re-checks on chain today, so the `to` of a
   * report transaction is what says which kind of run produced it. The steps
   * are in docs/developers/chainlink-workflow.md.
   */
  forwarder: "0x76c9cf548b4179F8901cda1f8623568b58215E62" as Hex,
  simulationForwarder: "0x9eF6468C5f37b976E57d52054c693269479A784d" as Hex,
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
 * The consent register's ABI. It is a separate contract from the registry
 * because the registry is immutable and statements arrived after it, so a
 * holder's word about AI use is read from here and nowhere else.
 */
export const consentAbi = consentAbiJson as Abi;

const RPC_OPTIONS = { batch: true, timeout: 15_000 } as const;

/**
 * Reads only, and only from the server. Keeping the reads on this side means
 * one endpoint answers for every visitor rather than every browser opening its
 * own connection to the chain.
 *
 * With MONAD_RPC_URL set, the dedicated endpoint answers first and the free
 * public one only picks up what it drops, so a rate-limited minute on either
 * side is a slower read rather than an error line on a passport page. Ranking
 * is off on purpose: the order is the one written here, not whichever endpoint
 * happened to be quickest a moment ago. Without the variable this is the plain
 * public transport the app has always used.
 */
export const chain = createPublicClient({
  chain: monad,
  transport:
    serverRpcUrl === undefined
      ? http(publicEnv.monadRpcUrl, RPC_OPTIONS)
      : fallback([http(serverRpcUrl, RPC_OPTIONS), http(publicEnv.monadRpcUrl, RPC_OPTIONS)], { rank: false }),
});

/**
 * Any absolute http or https address, wherever it sits in a line of text.
 *
 * One rule rather than a list of hosts: the endpoint we most need to keep out
 * of a page is the one nobody thought to add to a list. It covers anything with
 * an http or https scheme and it does not cover a bare hostname written without
 * one, which carries no access token in this app.
 */
const ANY_ADDRESS = /https?:\/\/\S+/gi;

/**
 * Turns any thrown value into one line a person can act on, with every address
 * taken out of it.
 *
 * viem writes the endpoint it called into its errors, several pages print this
 * line to a visitor, and the server may be reading through an endpoint whose
 * address is its access token. So the address never survives this function,
 * whichever endpoint it names.
 */
export function reason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split("\n")[0].replace(ANY_ADDRESS, "the RPC endpoint");
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
