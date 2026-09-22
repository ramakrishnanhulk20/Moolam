import { notFound } from "next/navigation";
import { getFormatter, setRequestLocale } from "next-intl/server";
import type { Hex } from "viem";
import { SealedBench, type SealedSubject } from "@/components/lab/sealed/SealedBench";
import { readArt } from "@/components/passport/art";
import { sketchBits } from "@/components/sealed/bits";
import { shortHex } from "@/lib/chain/client";
import { heldPassportRecord } from "@/lib/chain/registry";

// The plates are drawn from block hashes read on the request. A prerendered
// copy would draw whatever the registry held when the build ran, and the whole
// claim of this page is that the sketch is the record's own.
export const dynamic = "force-dynamic";

/**
 * Two real passports on mainnet. Both were drawn by the generator agent, which
 * is what nearly every record on the registry is today, and both are here for
 * their block hashes: a drawing that reads well on one picture and badly on
 * another is not a drawing anyone should ship.
 */
const SHOWN: { id: Hex; caption: string }[] = [
  {
    id: "0xcdb25d3755452efa3b746f168cf9cefd3a1b693ab2b81d260a2d64f13d771638",
    caption:
      "One of the fourteen real pictures on the registry, registered on 8 September. Every square in the plates below is a bit of its block hash.",
  },
  {
    id: "0x0c45b008db6a6b74b203e63e7659fc86c60c2598d762e0280c4ae12fc57e0e2e",
    caption:
      "A second real record, so a drawing can be judged on two pictures rather than one. Both were drawn by the Moolam generator agent.",
  },
];

/**
 * The sealed bench. Both plate drawings, the link preview and the studio switch
 * with its list of what becomes public, before any of it touches a real screen.
 * Nothing links here and the flag that opens it is only set on this machine.
 */
export default async function SealedLabPage({ params }: { params: Promise<{ locale: string }> }) {
  if (process.env.NEXT_PUBLIC_LAB_PAGES !== "1") {
    notFound();
  }

  const { locale } = await params;
  setRequestLocale(locale);

  const format = await getFormatter({ locale });
  const subjects = await Promise.all(
    SHOWN.map(async (shown) => await subjectFor(shown.id, shown.caption, (at: Date) => format.dateTime(at, { dateStyle: "medium" }))),
  );

  return <SealedBench subjects={subjects} />;
}

async function subjectFor(id: Hex, caption: string, when: (at: Date) => string): Promise<SealedSubject> {
  const record = await heldPassportRecord(id);
  const passport = record.passport;
  const art = passport === null ? { title: undefined } : await readArt(passport.metadataURI);
  const shortId = shortHex(id, 10, 8);

  if (passport === null) {
    return {
      id,
      shortId,
      caption,
      title: art.title ?? null,
      bits: null,
      blockhash: null,
      phash: null,
      phashHex: null,
      registered: "",
      agentId: "none",
      plateLine: "",
      cardLine: "",
    };
  }

  const date = when(new Date(Number(passport.registeredAt) * 1000));

  return {
    id,
    shortId,
    caption,
    title: art.title ?? null,
    bits: sketchBits(passport.blockhash256),
    blockhash: passport.blockhash256,
    phash: passport.phash.toString(),
    phashHex: `0x${passport.phash.toString(16).padStart(16, "0")}`,
    registered: date,
    agentId: passport.generatorAgentId === 0n ? "none" : passport.generatorAgentId.toString(),
    plateLine: `Registered ${date}. The picture is not published.`,
    cardLine: `Sealed on Monad, ${date}. The picture is not published.`,
  };
}
