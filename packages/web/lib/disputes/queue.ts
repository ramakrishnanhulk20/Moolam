import type { Hex } from "viem";
import { readArt } from "@/components/passport/art";
import { DisputeStatus, getDispute } from "@/lib/chain/registry";
import { evidenceMatches, reasonFrom } from "./evidence";
import { indexAvailable, openDisputes } from "./indexed";

/**
 * The queue the resolver works through.
 *
 * Two sources, each doing the thing only it can. The index answers "which
 * disputes are open", because the registry keeps no list. The registry then
 * answers for each one, because the index can be behind and the resolver is
 * about to spend somebody's bond on what this page says.
 *
 * Numbers cross to the browser as strings: a bigint cannot travel from a server
 * component to a client one, and rounding a bond into a JavaScript number is
 * how money goes missing.
 */

/** One open dispute, ready for the console. */
export interface OpenDispute {
  passportId: Hex;
  challenger: Hex;
  /** Wei, as a decimal string. */
  bond: string;
  /** Seconds since the epoch, as the registry recorded them. */
  openedAt: number;
  /** The challenger's words, when the evidence URI carries them. */
  reason: string | null;
  /** The evidence URI from the index, only when its hash matches the record. */
  evidenceURI: string | null;
  /** False when the index's URI does not hash to what the registry stores. */
  verified: boolean;
  title: string | null;
  thumbnailUrl: string | null;
}

/**
 * Every dispute the registry still has open, oldest first.
 *
 * Throws with the reason when there is no index to ask, because a console that
 * quietly showed an empty queue would look exactly like a day with no disputes.
 */
export async function openDisputeQueue(limit = 50): Promise<OpenDispute[]> {
  if (!indexAvailable()) {
    throw new Error("NEXT_PUBLIC_ENVIO_GRAPHQL_URL is not set, so the open disputes cannot be listed");
  }

  const indexed = await openDisputes(limit);
  const rows = await Promise.all(indexed.map(fromChain));
  return rows.filter((row): row is OpenDispute => row !== null);
}

async function fromChain(row: Awaited<ReturnType<typeof openDisputes>>[number]): Promise<OpenDispute | null> {
  const live = await getDispute(row.passportId).catch(() => null);
  if (live === null || live.status !== DisputeStatus.Open) {
    return null;
  }

  const verified = evidenceMatches(row.evidenceURI, live.evidenceHash);
  const art = row.metadataURI === "" ? null : await readArt(row.metadataURI);

  return {
    passportId: row.passportId,
    challenger: live.challenger,
    bond: live.bond.toString(),
    openedAt: Number(live.openedAt),
    reason: verified ? reasonFrom(row.evidenceURI) : null,
    evidenceURI: verified ? row.evidenceURI : null,
    verified,
    title: art?.title ?? null,
    thumbnailUrl: art?.thumbnailUrl ?? null,
  };
}
