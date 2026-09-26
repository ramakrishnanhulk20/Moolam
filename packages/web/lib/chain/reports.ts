import { unstable_cache } from "next/cache";
import type { Hex } from "viem";
import { CACHE_TAGS, addresses, chain } from "./client";
import { sameAddress } from "./receivers";

/**
 * Which forwarder carried a CRE report to the receiver.
 *
 * "simulation" is a run of the workflow on one machine through
 * `cre workflow simulate --broadcast`: real gas, a real transaction, no node
 * consensus. "network" is a run on the live Chainlink network. "unknown" is
 * every other answer, a transaction that cannot be read included, and the page
 * then says nothing rather than guessing.
 */
export type ReportDelivery = "simulation" | "network" | "unknown";

/** A mined transaction never changes, so its answer is worth holding for a day. */
const DELIVERY_HOLD_SECONDS = 86_400;

async function reportDelivery(txHash: Hex): Promise<ReportDelivery> {
  try {
    const transaction = await chain.getTransaction({ hash: txHash });
    const to = transaction.to ?? "";
    if (sameAddress(to, addresses.simulationForwarder)) {
      return "simulation";
    }
    return sameAddress(to, addresses.forwarder) ? "network" : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * The same read, held.
 *
 * It has to stay inside unstable_cache: the passport page holds every chain
 * read it makes, and an uncached one here would put an RPC round trip per
 * re-check back onto the page's own render. The hash is part of the key
 * because each transaction has its own answer.
 */
export async function heldReportDelivery(txHash: Hex): Promise<ReportDelivery> {
  const held = unstable_cache(async () => await reportDelivery(txHash), ["moolam-report-delivery", txHash], {
    revalidate: DELIVERY_HOLD_SECONDS,
    tags: [CACHE_TAGS.chain],
  });
  return await held();
}
