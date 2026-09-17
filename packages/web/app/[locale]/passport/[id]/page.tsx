import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import type { Hex } from "viem";
import { readArt, type Art } from "@/components/passport/art";
import { Attestations } from "@/components/passport/Attestations";
import { CheckCopy } from "@/components/passport/CheckCopy";
import { DisputeNote } from "@/components/passport/DisputeNote";
import { DisputePanel } from "@/components/passport/DisputePanel";
import { EditPanel } from "@/components/passport/EditPanel";
import { Facts } from "@/components/passport/Facts";
import { heldIndexedAttestations } from "@/components/passport/indexed";
import { standingOf } from "@/components/passport/labels";
import { Lineage } from "@/components/passport/Lineage";
import { Poster } from "@/components/passport/Poster";
import { WalletProvider } from "@/components/providers/WalletProvider";
import { reason } from "@/lib/chain/client";
import { DisputeStatus, ZERO_ID, heldPassportRecord } from "@/lib/chain/registry";
import type { PassportRecordBundle } from "@/lib/chain/registry";
import { activeSource } from "@/lib/data/source";
import { inheritedDisputed } from "@/lib/data/lineage";
import { heldRegistration } from "@/lib/data/passports";
import { realPictureIds } from "@/lib/data/prerender";
import { passportShareMetadata } from "./opengraph-image";

const ID_PATTERN = /^0x[0-9a-fA-F]{64}$/;

// A minute is the window every read on this page is already held for, and a
// write to the record drops the page on the spot, so nobody waits out the
// minute for their own edit, challenge or settlement.
export const revalidate = 60;

/**
 * The real pictures are built when the site is, so the first person to open one
 * after a deploy is handed a page rather than a cold chain, a cold index and a
 * cold gateway. Best effort on purpose: a list that cannot be read costs that
 * one first visit and never the build. Any other id still renders on demand.
 */
export async function generateStaticParams(): Promise<{ id: string }[]> {
  return (await realPictureIds()).map((id) => ({ id }));
}

/**
 * The head for one record, so a passport link pasted into a chat shows the
 * picture, its title and its block rather than the app's generic card.
 *
 * The title and the words come from the pinned metadata, read the same way the
 * page reads them. A gateway that will not answer costs the title, never the
 * page: the card and the head both fall back to the short id.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}): Promise<Metadata> {
  const { locale, id } = await params;
  const meta = await getTranslations({ locale, namespace: "meta" });

  let art: Art | null = null;
  if (ID_PATTERN.test(id)) {
    try {
      // The same held read the page itself makes, so a render costs one trip to
      // the registry however many times it is asked for the record.
      const { passport } = await heldPassportRecord(id as Hex);
      art = passport === null ? null : await readArt(passport.metadataURI);
    } catch {
      // The head is worth no failed page. The short id stands in.
    }
  }

  return passportShareMetadata({
    locale,
    id,
    title: art?.title,
    description: art?.description,
    fallbackDescription: meta("description"),
  });
}

/**
 * One registered image, and everything the chain and the index know about it.
 *
 * The record, its re-checks, its edits, the dispute if there is one and whether
 * the creator's wallet has a passkey bound are one held read of the registry.
 * The picture and the words come from the metadata that was pinned when it was
 * registered. The two panels at the foot of the page read live in the browser,
 * because what they show depends on who is looking.
 */
export default async function PassportPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("passport");

  if (!ID_PATTERN.test(id)) {
    return <Notice text={t("notFound")} />;
  }

  let record: PassportRecordBundle;
  try {
    record = await heldPassportRecord(id as Hex);
  } catch (error) {
    return <Notice text={t("error", { reason: reason(error) })} tone="failed" />;
  }

  const { passport, attestations, edits, owner, dispute, hasPasskey } = record;
  if (passport === null) {
    return <Notice text={t("notFound")} />;
  }

  // The picture, the transaction links and the lineage's standing are the three
  // things this page can do without, so none of them is allowed to fail the
  // render.
  const [art, indexed, registration, ancestorDisputed] = await Promise.all([
    readArt(passport.metadataURI),
    heldIndexedAttestations(passport.id),
    registrationOf(passport.id),
    ancestorsDisputed(passport.parentId),
  ]);
  const standing = standingOf({ disputed: passport.disputed, inherited: ancestorDisputed, attestations });

  return (
    <article>
      <Poster passport={passport} art={art} locale={locale} />

      {/* The second opinion leads, straight under the poster: it is the one
          fact on this page nobody could have written about themselves. */}
      <Attestations attestations={attestations} indexed={indexed} phash={passport.phash} locale={locale} />

      <Facts
        passport={passport}
        art={art}
        owner={owner}
        hasPasskey={hasPasskey}
        standing={standing}
        txHash={registration}
      />

      {/* Everything above is the record itself and needs no wallet. The two
          panels that write live down here, and they share one provider: a
          visitor who signs in to challenge a picture is the same visitor the
          edit panel asks about. The rest of this block is server rendered and
          passes straight through. */}
      <WalletProvider load="returning">
        <div className="mx-auto w-full max-w-[1400px] px-5 pb-24 sm:px-8 sm:pb-32">
          {dispute === null ? null : (
            <div className="mb-16 rise">
              <DisputeNote dispute={dispute} passportId={passport.id} locale={locale} />
            </div>
          )}

          {/* Only a signed in visitor who does not hold this passport sees this. */}
          <DisputePanel
            passportId={passport.id}
            owner={owner}
            disputeOpen={dispute !== null && dispute.status === DisputeStatus.Open}
          />

          <div className="grid gap-12 border-t border-line pt-14 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-20">
            <div className="rise">
              <Lineage parentId={passport.parentId} edits={edits} parentDisputed={ancestorDisputed} />
              {/* Only the wallet that holds this passport ever sees this panel. */}
              <EditPanel parentId={passport.id} owner={owner} />
            </div>
            <div className="rise" style={{ animationDelay: "90ms" }}>
              <CheckCopy passportId={passport.id} />
            </div>
          </div>
        </div>
      </WalletProvider>
    </article>
  );
}

/**
 * Whether the picture this one was edited from, or anything above that, had a
 * dispute upheld on it.
 *
 * The registry marks only the passport a challenge named, so this answer exists
 * nowhere on chain and only the index can give it. An index that will not
 * answer costs the page the word and the mark: it then says what the chain said
 * about this record and nothing about its ancestors, which is better than
 * guessing in either direction.
 */
async function ancestorsDisputed(parentId: Hex): Promise<boolean> {
  if (parentId === ZERO_ID || activeSource() !== "envio") {
    return false;
  }
  try {
    return await inheritedDisputed(parentId);
  } catch {
    return false;
  }
}

/**
 * The transaction that wrote this passport, which exists only in the index. No
 * index, or an index that will not answer, costs the explorer link and nothing
 * else on the page.
 */
async function registrationOf(id: Hex): Promise<Hex | null> {
  if (activeSource() !== "envio") {
    return null;
  }
  try {
    return (await heldRegistration(id))?.txHash ?? null;
  } catch {
    return null;
  }
}

function Notice({ text, tone }: { text: string; tone?: "failed" }) {
  return (
    <div className="mx-auto w-full max-w-[1400px] px-5 py-24 sm:px-8">
      <p
        className={
          tone === "failed" ? "rise max-w-[52ch] text-base text-failed" : "rise max-w-[52ch] text-base text-text-muted"
        }
      >
        {text}
      </p>
    </div>
  );
}
