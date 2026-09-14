import { unstable_cache } from "next/cache";
import type { Hex } from "viem";
import { CACHE_TAGS, HOLD_SECONDS, chain, REPUTATION_REGISTRY } from "./client";

/**
 * The two reads Moolam needs from the ERC-8004 reputation registry on Monad
 * mainnet. Its summary is filtered by tag, so the same pair of tags the
 * verifier writes has to be asked for here.
 */
const reputationAbi = [
  {
    type: "function",
    name: "getClients",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "clients", type: "address[]" }],
  },
  {
    type: "function",
    name: "getSummary",
    stateMutability: "view",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "clientAddresses", type: "address[]" },
      { name: "tag1", type: "string" },
      { name: "tag2", type: "string" },
    ],
    outputs: [
      { name: "count", type: "uint64" },
      { name: "value", type: "int128" },
      { name: "valueDecimals", type: "uint8" },
    ],
  },
] as const;

export const FEEDBACK_TAGS = ["moolam", "verification"] as const;

/** Everyone who has left feedback about this agent. */
export async function getReputationClients(agentId: bigint): Promise<Hex[]> {
  const clients = await chain.readContract({
    address: REPUTATION_REGISTRY,
    abi: reputationAbi,
    functionName: "getClients",
    args: [agentId],
  });
  return [...clients] as Hex[];
}

/**
 * The agent's score from the clients given.
 *
 * An empty client list means nobody has rated it, and the registry would answer
 * a zero summary for that, so it is short-circuited here to keep the page from
 * printing "score 0" for an agent that simply has no reviews yet.
 */
export async function getReputation(
  agentId: bigint,
  clients: Hex[],
): Promise<{ count: bigint; value: bigint; decimals: number }> {
  if (clients.length === 0) {
    return { count: 0n, value: 0n, decimals: 0 };
  }

  const [count, value, decimals] = await chain.readContract({
    address: REPUTATION_REGISTRY,
    abi: reputationAbi,
    functionName: "getSummary",
    args: [agentId, clients, FEEDBACK_TAGS[0], FEEDBACK_TAGS[1]],
  });

  return { count: BigInt(count), value: BigInt(value), decimals: Number(decimals) };
}

/**
 * Both reads behind the feedback line, as one call held for a minute.
 *
 * The client list and the summary are two round trips that always travel
 * together, so they are held together. The two figures cross the cache as
 * strings: what is kept has to survive JSON, and a bigint does not.
 */
const heldSummary = unstable_cache(
  async (agentId: string) => {
    const id = BigInt(agentId);
    const summary = await getReputation(id, await getReputationClients(id));
    return { count: summary.count.toString(), value: summary.value.toString(), decimals: summary.decimals };
  },
  ["moolam-agent-reputation"],
  { revalidate: HOLD_SECONDS, tags: [CACHE_TAGS.chain] },
);

export async function heldReputation(agentId: bigint): Promise<{ count: bigint; value: bigint; decimals: number }> {
  const summary = await heldSummary(agentId.toString());
  return { count: BigInt(summary.count), value: BigInt(summary.value), decimals: summary.decimals };
}
