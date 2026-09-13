import { cache } from "react";
import { readCard } from "@/components/agent/card";
import { getAgent } from "@/lib/chain/registry";
import type { GeneratorStanding } from "@/lib/data/passports";

/** One line of the roster: what the index counted, plus the name the agent's own card carries. */
export interface AgentRow {
  id: string;
  /** Null when the identity registry or the card could not be read, or the card has no name. */
  name: string | null;
  passportCount: number;
  matchedCount: number;
  mismatchedCount: number;
  disputesUpheld: number;
  trustScore: number;
  /** Seconds since the epoch, the first time the index saw this agent sign. */
  firstSeenAt: number;
}

/**
 * The agent's registration card, read once per request however many rows ask
 * for it. Two rows for the same id would otherwise be two identical reads of
 * the identity registry on every page view.
 */
const cardFor = cache(async (agentId: string): Promise<string | null> => {
  try {
    const name = readCard((await getAgent(BigInt(agentId))).card)?.name?.trim();
    return name === undefined || name === "" ? null : name;
  } catch {
    return null;
  }
});

/**
 * The index's generators with their names.
 *
 * The counts are the index's, because that is the only place they are added up.
 * The name is the chain's, from the ERC-8004 card at the agent's tokenURI. An
 * identity registry that will not answer costs the name and nothing else: the
 * row still stands on its number.
 */
export async function roster(standings: GeneratorStanding[]): Promise<AgentRow[]> {
  return await Promise.all(
    standings.map(async (standing) => ({
      id: standing.id,
      name: await cardFor(standing.id),
      passportCount: standing.passportCount,
      matchedCount: standing.matchedCount,
      mismatchedCount: standing.mismatchedCount,
      disputesUpheld: standing.disputesUpheld,
      trustScore: standing.trustScore,
      firstSeenAt: Number(standing.firstSeenAt),
    })),
  );
}
