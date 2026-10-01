import type { Hex } from "viem";
import { chain } from "@/lib/chain/client";
import { DisputeStatus, getDispute } from "@/lib/chain/registry";
import { DECISIONS_ADDRESS } from "./decisionsContract";
import { indexAvailable, settledDisputes, type IndexedDispute } from "./indexed";
import { decisionsAbi } from "./reasons";

/** One settled dispute whose reasons are not on Monad yet. */
export interface WaitingReasons {
  passportId: Hex;
  upheld: boolean;
  /** Unix seconds, as getDispute holds it. */
  openedAt: number;
  /** Unix seconds the index says it was settled, when it says. */
  resolvedAt: number | null;
}

/**
 * The decisions still owed their published reasons, for the resolver's desk.
 *
 * The index lists the settled disputes, because the registry keeps no list;
 * the registry then says each one is still settled with that openedAt, and
 * MoolamDecisions says its reasons are not published. Anything the two do not
 * both confirm is left off rather than offered.
 */
export async function waitingReasons(limit = 20): Promise<WaitingReasons[]> {
  if (!indexAvailable()) {
    return [];
  }
  const rows = await settledDisputes(limit);
  const checked = await Promise.all(rows.map(stillOwed));
  return checked.filter((row): row is WaitingReasons => row !== null);
}

async function stillOwed(row: IndexedDispute): Promise<WaitingReasons | null> {
  try {
    const live = await getDispute(row.passportId);
    if (
      live === null ||
      (live.status !== DisputeStatus.Upheld && live.status !== DisputeStatus.Rejected) ||
      live.openedAt !== row.openedAt
    ) {
      return null;
    }
    const published = (await chain.readContract({
      address: DECISIONS_ADDRESS,
      abi: decisionsAbi,
      functionName: "published",
      args: [row.passportId, live.openedAt],
    })) as boolean;
    if (published) {
      return null;
    }
    return {
      passportId: row.passportId,
      upheld: live.status === DisputeStatus.Upheld,
      openedAt: Number(live.openedAt),
      resolvedAt: row.resolvedAt === null ? null : Number(row.resolvedAt),
    };
  } catch {
    return null;
  }
}
