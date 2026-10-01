"use server";

import type { Hex } from "viem";
import type { MarkVerdict } from "@/components/mark/mark";
import { networkVerdicts } from "@/components/mark/read";
import { heldIndexedVerdictRows } from "@/components/passport/indexed";
import { heldPassportRecord } from "@/lib/chain/registry";
import { markSchema } from "@/lib/data/marks";

const ID_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/**
 * Where the newest verdict on one passport came from, by the trust mark's own
 * rule (components/mark/read.ts): "network" for one Chainlink's network
 * delivered, "testRun" for a run in its simulator, "none" when nothing has
 * been written, "unread" when a read behind the answer failed.
 *
 * The verify page reads the service and Monad from the browser on purpose,
 * and nothing about a reader's file comes through here. What the browser
 * cannot read is which forwarder carried a verdict: that lives in the index's
 * rows and the chain's transactions, which this server already holds for the
 * passport page. So that one question is asked of the same held reads, and a
 * stranger with a passport id gets the answer the passport page draws.
 */
export async function newestVerdictStanding(id: string): Promise<"network" | "testRun" | "none" | "unread"> {
  if (!ID_PATTERN.test(id)) {
    return "unread";
  }
  try {
    const [record, rows, schema] = await Promise.all([
      heldPassportRecord(id as Hex),
      heldIndexedVerdictRows(id as Hex).catch(() => null),
      markSchema(),
    ]);
    if (record.passport === null) {
      return "unread";
    }
    if (record.attestations.length === 0) {
      return "none";
    }
    const verdicts = await networkVerdicts(record.passport, record.attestations, rows, schema.network);
    if (verdicts === null) {
      return "unread";
    }
    let newest: MarkVerdict | null = null;
    for (const verdict of verdicts) {
      if (newest === null || verdict.at > newest.at) {
        newest = verdict;
      }
    }
    return newest === null ? "none" : newest.network ? "network" : "testRun";
  } catch {
    return "unread";
  }
}
