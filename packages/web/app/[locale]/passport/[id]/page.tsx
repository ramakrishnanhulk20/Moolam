import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import type { Hex } from "viem";
import { readArt, type Art } from "@/components/passport/art";
import { Attestations } from "@/components/passport/Attestations";
import { CheckCopy } from "@/components/passport/CheckCopy";
import { ConsentSection, type ConsentRecord } from "@/components/consent/ConsentSection";
import { shareDescription } from "@/components/consent/share";
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
import { heldConsent, heldConsentHistory, heldMinInterval, heldStandard } from "@/lib/chain/consent";
import type { ConsentReading } from "@/lib/chain/consent";
import { DisputeStatus, ZERO_ID, heldPassportRecord } from "@/lib/chain/registry";
import type { PassportRecordBundle } from "@/lib/chain/registry";
import { headTimestamp } from "@/lib/chain/time";
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
 *
 * The description leads with what the holder has said about AI use, because
 * that is the one line about this picture that is not true of every other one
 * in the app, and a link is often all anyone sees.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}): Promise<Metadata> {
  const { locale, id } = await params;
  const meta = await getTranslations({ locale, namespace: "meta" });
  const words = await getTranslations({ locale, namespace: "passport.consent" });
  const format = await getFormatter({ locale });

  let art: Art | null = null;
  let consent: ConsentReading | null = null;
  if (ID_PATTERN.test(id)) {
    try {
      // The same held read the page itself makes, so a render costs one trip to
      // the registry however many times it is asked for the record.
      const { passport } = await heldPassportRecord(id as Hex);
      art = passport === null ? null : await readArt(passport.metadataURI);
    } catch {
      // The head is worth no failed page. The short id stands in.
    }

    try {
      // Held under this passport's own name and read again below, so the head
      // costs the register no call of its own.
      consent = await heldConsent(id as Hex);
    } catch {
      // A register that will not answer leaves the description as it was.
    }
  }

  return passportShareMetadata({
    locale,
    id,
    title: art?.title,
    description: shareDescription(consent, art?.description, meta("description"), (statement, at) =>
      words("shared", {
        statement: words(`summary.${statement}`),
        when: format.dateTime(new Date(at * 1000), { dateStyle: "medium" }),
      }),
    ),
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

  // An id that is not a passport id, and an id the registry has no record of,
  // are both a page that does not exist: they answer 404 with the site's own
  // not-found page rather than 200 with a sentence, so a crawler never files a
  // mistyped address as a real passport.
  if (!ID_PATTERN.test(id)) {
    notFound();
  }

  let record: PassportRecordBundle;
  try {
    record = await heldPassportRecord(id as Hex);
  } catch (error) {
    // One bad second on the chain must never become the page everyone opening
    // this passport is handed for the next minute. Asking for the connection
    // takes this render out of the store the way the Explore sheet does: a
    // build leaves the page to be drawn on the request, and a refresh keeps the
    // last good page it already has and tries the chain again on the next one.
    await connection();
    return <Notice text={t("error", { reason: reason(error) })} tone="failed" />;
  }

  const { passport, attestations, edits, owner, dispute, hasPasskey } = record;
  if (passport === null) {
    notFound();
  }

  // The picture, the transaction links and the lineage's standing are the three
  // things this page can do without, so none of them is allowed to fail the
  // render.
  const [art, indexed, registration, ancestorDisputed, consent] = await Promise.all([
    readArt(passport.metadataURI),
    heldIndexedAttestations(passport.id),
    registrationOf(passport.id),
    ancestorsDisputed(passport.parentId),
    consentOf(passport.id),
  ]);
  const standing = standingOf({ disputed: passport.disputed, inherited: ancestorDisputed, attestations });

  return (
    <article>
      <Poster passport={passport} art={art} locale={locale} />

      {/* The second opinion leads, straight under the poster: it is the one
          fact on this page nobody could have written about themselves. */}
      <Attestations
        attestations={attestations}
        indexed={indexed}
        phash={passport.phash}
        locale={locale}
        sealed={art.sealed === true}
      />

      {/* The three panels that write share one provider, so the wallet SDK is
          fetched and mounted once for a page that may ask about the reader
          three times. Everything inside here that is not a panel is server
          rendered and passes straight through. */}
      <WalletProvider load="returning">
        {/* Everything above this line is what the picture is. This is what its
            holder says may be done with it, which is the question anyone
            training a model has to answer before they use it. */}
        <ConsentSection
          id={passport.id}
          owner={owner}
          registeredAt={Number(passport.registeredAt)}
          record={consent}
        />

        <Facts
          passport={passport}
          art={art}
          owner={owner}
          hasPasskey={hasPasskey}
          standing={standing}
          txHash={registration}
        />

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
              <EditPanel parentId={passport.id} owner={owner} sealed={art.sealed === true} />
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
 * What the holder has said about AI use, with the register's own vocabulary and
 * its waiting rule, read together.
 *
 * Every read here is held under this passport's own name, so a statement
 * written from this page drops with the rest of it. A register that will not
 * answer costs the section its card and nothing else: the page says so in
 * words, because a silent section would read as a holder who said nothing, and
 * those are two different answers.
 */
async function consentOf(id: Hex): Promise<ConsentRecord | null> {
  try {
    const [reading, history, standard, minInterval, now] = await Promise.all([
      heldConsent(id),
      heldConsentHistory(id),
      heldStandard(),
      heldMinInterval(),
      headTimestamp(),
    ]);
    return { reading, history, standard, minInterval, now: Number(now) };
  } catch {
    return null;
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
