"use server";

import { headers } from "next/headers";
import { getAddress, type Hex } from "viem";
import { readCard } from "@/components/agent/card";
import { signedWorks } from "@/components/agent/signed";
import { isTestCard } from "@/components/explore/sort";
import { callerFromHeaders, withinLimit } from "@/lib/api/limit";
import { addresses, chain } from "@/lib/chain/client";
import { heldAgent } from "@/lib/chain/registry";
import { heldPlatformList } from "@/lib/data/platform-label";
import { agentOwnerUnchanged } from "@/lib/platforms/platforms";
import { listingFor, type AgentFacts } from "./listing";

const AGENT_ID = /^[1-9][0-9]{0,77}$/;

const OWNER_OF = [
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ type: "address" }],
  },
] as const;

/** Read now, never from a hold: the badge depends on who owns the agent at this moment (P16). */
async function ownerNow(agentId: bigint): Promise<Hex> {
  return (await chain.readContract({
    address: addresses.agentIdentity,
    abi: OWNER_OF,
    functionName: "ownerOf",
    args: [agentId],
  })) as Hex;
}

/**
 * Who drew the picture a person is about to co-sign, from an agent id and
 * nothing else. The id is public, unlike the handle, so it may reach the server.
 *
 * Three facts at three trust levels, never merged (P14, P16): the name on the
 * agent's own card, which nobody checked; the agent's owner read now; and the
 * platform Moolam lists for that agent, named only when the owner read now is
 * the owner that signed at onboarding. Anyone can call this, so it takes a
 * bounded decimal id and answers null past the per-caller limit.
 */
export async function cosignAgentFacts(agentId: string): Promise<AgentFacts | null> {
  if (typeof agentId !== "string" || !AGENT_ID.test(agentId)) {
    return null;
  }
  if (!withinLimit("cosign-agent", callerFromHeaders(await headers())).ok) {
    return null;
  }
  const id = BigInt(agentId);

  const [owner, agent, list, works] = await Promise.all([
    ownerNow(id)
      .then((value) => getAddress(value))
      .catch(() => null),
    heldAgent(agentId).catch(() => null),
    heldPlatformList(),
    signedWorks(id).catch(() => []),
  ]);

  const entry = listingFor(list, id);
  const badge =
    entry !== null && owner !== null && (await agentOwnerUnchanged(entry, async () => owner));

  return {
    agentId,
    name: agent === null ? null : (readCard(agent.card)?.name ?? null),
    owner,
    listing: entry === null ? null : { name: entry.name, origins: [...entry.origins], badge },
    field: works
      .filter((work) => !isTestCard(work.title ?? null, work.id))
      .flatMap((work) => (work.thumbnailUrl === undefined ? [] : [work.thumbnailUrl]))
      .slice(0, 12),
  };
}
