import type { Hex } from "viem";
import type { Platform, PlatformList } from "@/lib/platforms/platforms";

/** What the co-sign page knows about the agent behind a record, each fact at its own trust level. */
export interface AgentFacts {
  agentId: string;
  /** The name on the agent's own card. Self-declared: nobody checked it (P14). */
  name: string | null;
  /** ownerOf(agentId) read now, checksummed, or null when the read failed. */
  owner: Hex | null;
  /** The platform Moolam lists for this agent, or null when none is listed. */
  listing: {
    name: string;
    /** Where the page may tell the platform the passport landed (P10). */
    origins: string[];
    /** False when the agent changed hands since onboarding, so the name is withheld (P16). */
    badge: boolean;
  } | null;
  /** Thumbnails of the agent's other pictures, for the faded field behind the print. */
  field: string[];
}

/**
 * The current listing for an agent: the entry whose agent id it is and whose
 * window is still open. A refused list lists nobody (P15).
 */
export function listingFor(list: PlatformList, agentId: bigint): Platform | null {
  if (!list.ok) {
    return null;
  }
  return list.platforms.find((entry) => entry.agentId === agentId && entry.validTo === null) ?? null;
}
