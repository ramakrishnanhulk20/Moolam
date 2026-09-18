import { notFound } from "next/navigation";
import { setRequestLocale } from "next-intl/server";
import type { Hex } from "viem";
import { ConsentBench, type Subject } from "@/components/lab/consent/ConsentBench";
import { readArt } from "@/components/passport/art";
import { heldConsent, heldConsentHistory, heldMinInterval, heldStandard } from "@/lib/chain/consent";
import { heldPassportRecord } from "@/lib/chain/registry";
import { headTimestamp } from "@/lib/chain/time";

// Every statement, date and writer on this bench is read on the request. A
// prerendered copy would show what the register held when the build ran, and a
// page about what was true on a given day cannot be stale about today.
export const dynamic = "force-dynamic";

/**
 * Four real passports, picked to cover the four things the register can answer:
 * a closed statement, an open one, one with conditions and a real address to
 * ask at, and a picture whose holder has never said anything. Nothing about
 * them is written into this page beyond the id. The words, the dates, the
 * writer and the history all come off the chain while the page renders.
 */
const SHOWN: { id: Hex; caption: string }[] = [
  {
    id: "0xcdb25d3755452efa3b746f168cf9cefd3a1b693ab2b81d260a2d64f13d771638",
    caption: "A holder who says no. The case the web has no way to say today.",
  },
  {
    id: "0x0c45b008db6a6b74b203e63e7659fc86c60c2598d762e0280c4ae12fc57e0e2e",
    caption: "A holder who says yes to everything, training included.",
  },
  {
    id: "0x0a3c8368198f7c52597338543141797b0ab395ff53a3590499099238f85f15ae",
    caption: "A holder who says ask first, and leaves a real address to ask at.",
  },
  {
    id: "0x3dae5ee9d854d6af49857150873cefbe2df2a585e35ea86d34f0f47cb3b6403d",
    caption: "A picture nobody has spoken for. Silence, reported as silence.",
  },
];

/**
 * The consent bench: the card a passport page will carry, drawn twice, with the
 * control a creator uses and the line a verify answer prints. Nothing links
 * here and the flag that opens it is only set on this machine, so the route is
 * a 404 everywhere else.
 */
export default async function ConsentLabPage({ params }: { params: Promise<{ locale: string }> }) {
  if (process.env.NEXT_PUBLIC_LAB_PAGES !== "1") {
    notFound();
  }

  const { locale } = await params;
  setRequestLocale(locale);

  // The end of every rule on this page is the chain's own clock, not this
  // machine's: the statements are dated in block time and a rule that ended at
  // a laptop's idea of now could put today's statement in the future.
  const [standard, minInterval, head, subjects] = await Promise.all([
    heldStandard(),
    heldMinInterval(),
    headTimestamp(),
    Promise.all(SHOWN.map(async (shown) => await subjectFor(shown.id, shown.caption))),
  ]);

  return <ConsentBench subjects={subjects} standard={standard} minInterval={minInterval} now={Number(head)} />;
}

async function subjectFor(id: Hex, caption: string): Promise<Subject> {
  const [record, reading, history] = await Promise.all([heldPassportRecord(id), heldConsent(id), heldConsentHistory(id)]);

  const art =
    record.passport === null ? { title: undefined } : await readArt(record.passport.metadataURI);

  return {
    id,
    caption,
    title: art.title ?? null,
    registeredAt: record.passport === null ? 0 : Number(record.passport.registeredAt),
    owner: record.owner,
    reading,
    history,
  };
}
