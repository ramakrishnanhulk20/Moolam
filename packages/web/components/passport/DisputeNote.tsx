import type { Hex } from "viem";
import { DisputeStatus, type Dispute } from "@/lib/chain/registry";
import { heldAnswer } from "@/lib/disputes/answerService";
import { decisionView, heldDecision, resolvedAtFromChain, type DecisionView } from "@/lib/disputes/decisions";
import { evidenceMatches, reasonFrom } from "@/lib/disputes/evidence";
import { heldIndexedRow, type IndexedDispute } from "@/lib/disputes/indexed";
import { answerStanding, chainNow } from "@/lib/disputes/standing";
import { ChallengeRecord, type ChallengeEvidence } from "@/components/challenge/ChallengeRecord";
import { DecisionBlock } from "@/components/challenge/DecisionBlock";

/**
 * A challenge against this passport, with the bond behind it, the words the
 * challenger put their money on and the holder's answer.
 *
 * Only shown when there is one: a passport nobody has challenged says nothing
 * here rather than printing an empty dispute box, which would read like an
 * accusation on every page.
 *
 * The reason lives in the evidence URI, which the registry keeps only as a
 * hash, so it is read from the index and then checked against that hash. An
 * index that is behind, missing or wrong costs the sentence and never the box.
 * The holder's answer comes from the verify service and is checked again here
 * against this dispute and the holder's signature before a word of it is drawn.
 * A settled dispute carries its decision and the reasons Moolam published.
 *
 * All three reads are the held ones: this renders inside the passport page,
 * which is built once a minute, and a read that is never kept makes Next throw
 * out of that page.
 */
export async function DisputeNote({
  dispute,
  passportId,
}: {
  dispute: Dispute;
  passportId: Hex;
  locale: string;
}) {
  const [row, read, now] = await Promise.all([
    heldIndexedRow(passportId),
    heldAnswer(passportId),
    chainNow(),
  ]);
  const [answer, decision] = await Promise.all([
    answerStanding({ read, passportId, dispute, now }),
    decisionOf(passportId, dispute, row),
  ]);

  return (
    <ChallengeRecord
      passportId={passportId}
      dispute={dispute}
      evidence={evidenceOf(row, dispute.evidenceHash)}
      answer={answer}
      decision={decision === null ? null : <DecisionBlock view={decision} />}
    />
  );
}

/**
 * The decision for a settled dispute: its published reasons, and the day it was
 * settled, from the index's row when that row is this very dispute, else from
 * the registry's own DisputeResolved event.
 */
async function decisionOf(passportId: Hex, dispute: Dispute, row: IndexedDispute | null): Promise<DecisionView | null> {
  if (dispute.status !== DisputeStatus.Upheld && dispute.status !== DisputeStatus.Rejected) {
    return null;
  }
  const openedAt = Number(dispute.openedAt);
  const indexedAt =
    row !== null && row.openedAt === dispute.openedAt && row.resolvedAt !== null ? Number(row.resolvedAt) : null;
  const [read, resolvedAt] = await Promise.all([
    heldDecision(passportId, openedAt),
    indexedAt === null ? resolvedAtFromChain(passportId) : Promise.resolve(indexedAt),
  ]);
  return decisionView(dispute, read, resolvedAt);
}

/**
 * The challenger's own words, read from the index and checked against the hash
 * on the record.
 *
 * The check is the point. The index is a mirror of the log, and printing text
 * from a mirror next to an accusation without proving it is the text that was
 * hashed would let a wrong index put words in somebody's mouth.
 */
function evidenceOf(row: IndexedDispute | null, hash: Hex): ChallengeEvidence | null {
  if (row === null || !evidenceMatches(row.evidenceURI, hash)) {
    return null;
  }
  return { reason: reasonFrom(row.evidenceURI), uri: row.evidenceURI };
}
