import type { Hex } from "viem";
import type { AnswerStanding } from "@/components/challenge/AnswerShown";
import { pinnedUri } from "@/components/passport/art";
import { gatewayUrl } from "@/lib/chain/client";
import { DisputeStatus, getDispute, getOwner } from "@/lib/chain/registry";
import { passportArt } from "@/lib/studio/metadata";
import { readAnswer } from "./answerService";
import { evidenceMatches, reasonFrom } from "./evidence";
import { indexAvailable, openDisputesHeldBy, type IndexedDispute } from "./indexed";
import { answerStanding, chainNow } from "./standing";

/** One challenge against a passport this wallet holds, ready for My pictures. */
export interface HeldChallenge {
  passportId: Hex;
  challenger: Hex;
  /** Unix seconds, as getDispute holds it. */
  openedAt: number;
  /** The challenger's words, only when they hash to what the registry stores. */
  reason: string | null;
  title?: string;
  imageUrl?: string;
  answer: AnswerStanding;
}

/**
 * The challenges this wallet can still answer, or has answered, read for the
 * holder's own page.
 *
 * The index answers "which disputes are open on passports this address holds",
 * because the registry keeps no list; the registry then answers for each one,
 * with ownerOf, because the index can be behind and a form offered to a wallet
 * that no longer holds the passport would only ever be refused. Throws when the
 * index cannot be asked, so the page stays silent rather than saying "none".
 */
export async function heldChallenges(wallet: Hex): Promise<HeldChallenge[]> {
  if (!indexAvailable()) {
    return [];
  }
  const rows = await openDisputesHeldBy(wallet);
  if (rows.length === 0) {
    return [];
  }
  const now = await chainNow();
  const found = await Promise.all(rows.map(async (row) => await fromChain(row, wallet, now)));
  return found.filter((row): row is HeldChallenge => row !== null);
}

async function fromChain(row: IndexedDispute, wallet: Hex, now: number): Promise<HeldChallenge | null> {
  const [live, owner] = await Promise.all([getDispute(row.passportId).catch(() => null), getOwner(row.passportId)]);
  if (live === null || live.status !== DisputeStatus.Open || owner === null || owner.toLowerCase() !== wallet.toLowerCase()) {
    return null;
  }
  const [read, art] = await Promise.all([readAnswer(row.passportId), artOf(row.metadataURI)]);
  const answer = await answerStanding({ read, passportId: row.passportId, dispute: live, now });
  if (answer.kind === "none" || answer.kind === "missed") {
    return null;
  }
  return {
    passportId: row.passportId,
    challenger: live.challenger,
    openedAt: Number(live.openedAt),
    reason: evidenceMatches(row.evidenceURI, live.evidenceHash) ? reasonFrom(row.evidenceURI) : null,
    ...art,
    answer,
  };
}

/** The title and thumbnail, held to the site's picture-address rule before anything is fetched. A miss costs the picture, never the row. */
async function artOf(metadataURI: string): Promise<{ title?: string; imageUrl?: string }> {
  const document = pinnedUri(metadataURI);
  if (document === undefined) {
    return {};
  }
  try {
    const response = await fetch(gatewayUrl(document), { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) {
      return {};
    }
    const art = passportArt(await response.json());
    const picture = art.uri === undefined ? undefined : pinnedUri(art.uri);
    return { title: art.title, imageUrl: picture === undefined ? undefined : gatewayUrl(picture) };
  } catch {
    return {};
  }
}
