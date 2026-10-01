import type { Hex } from "viem";
import type { AnswerStanding } from "@/components/challenge/AnswerShown";
import { DisputeStatus, type Dispute } from "@/lib/chain/registry";
import { headTimestamp } from "@/lib/chain/time";
import { answerBy, holderWords } from "./answer";
import type { AnswerRead } from "./answerService";

/**
 * What the holder's side of a dispute says, from the service's answer and the
 * chain's clock (L27).
 *
 * An answer is drawn only when it matches this very dispute. Without one, an
 * open dispute says until when the holder may answer, or that the 14 days
 * passed; a settled dispute without one says nothing, because it may have been
 * settled before the 14 days ran out. A read that failed is said in words and
 * never reads as "not answered".
 */
export async function answerStanding({
  read,
  passportId,
  dispute,
  now,
}: {
  read: AnswerRead;
  passportId: Hex;
  dispute: Pick<Dispute, "challenger" | "openedAt" | "status">;
  /** Unix seconds by the chain's clock. */
  now: number;
}): Promise<AnswerStanding> {
  const openedAt = Number(dispute.openedAt);
  const open = dispute.status === DisputeStatus.Open;
  if (read.kind === "found") {
    const words = await holderWords(read, passportId, { challenger: dispute.challenger, openedAt });
    if (words !== null) {
      return { kind: "answered", words };
    }
  }
  if (read.kind === "failed") {
    return { kind: "unread" };
  }
  if (!open) {
    return { kind: "none" };
  }
  const until = answerBy(openedAt);
  return now <= until ? { kind: "waiting", until } : { kind: "missed" };
}

/** Whether the holder's form belongs beside this dispute: open, inside its 14 days, and not yet answered. */
export function answerOpen(standing: AnswerStanding): standing is { kind: "waiting"; until: number } {
  return standing.kind === "waiting";
}

/**
 * Now, by the chain's clock, which is the clock the 14 days are judged by. A
 * head that cannot be read falls back to this machine's clock, which only ever
 * decides which of two waiting lines is drawn, never whether an answer counts.
 */
export async function chainNow(): Promise<number> {
  try {
    return Number(await headTimestamp());
  } catch {
    return Math.floor(Date.now() / 1000);
  }
}
