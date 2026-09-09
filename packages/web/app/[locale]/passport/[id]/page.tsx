import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import type { Hex } from "viem";
import { readArt } from "@/components/passport/art";
import { Attestations } from "@/components/passport/Attestations";
import { CheckCopy } from "@/components/passport/CheckCopy";
import { DisputeNote } from "@/components/passport/DisputeNote";
import { Facts } from "@/components/passport/Facts";
import { indexedAttestations } from "@/components/passport/indexed";
import { standingOf } from "@/components/passport/labels";
import { Lineage } from "@/components/passport/Lineage";
import { Poster } from "@/components/passport/Poster";
import { reason } from "@/lib/chain/client";
import {
  getAttestations,
  getChildren,
  getDispute,
  getOwner,
  getPasskey,
  getPassport,
} from "@/lib/chain/registry";
import type { Attestation, Dispute, Passport } from "@/lib/chain/registry";

const ID_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}): Promise<Metadata> {
  const { locale, id } = await params;
  const t = await getTranslations({ locale, namespace: "passport" });
  return { title: `${t("title")} ${id.slice(0, 10)}` };
}

/**
 * One registered image, and everything the chain and the index know about it.
 *
 * Every read here is live: the record, its re-checks, its edits, the dispute if
 * there is one, and whether the creator's wallet has a passkey bound. The
 * picture and the words come from the metadata that was pinned when it was
 * registered.
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

  let passport: Passport | null;
  let attestations: Attestation[] = [];
  let edits: Hex[] = [];
  let owner: Hex | null = null;
  let dispute: Dispute | null = null;
  let hasPasskey = false;

  try {
    passport = await getPassport(id as Hex);
    if (passport !== null) {
      const creator = passport.creator;
      const [foundAttestations, foundEdits, foundOwner, foundDispute, passkey] = await Promise.all([
        getAttestations(id as Hex),
        getChildren(id as Hex),
        getOwner(id as Hex),
        getDispute(id as Hex),
        getPasskey(creator),
      ]);
      attestations = foundAttestations;
      edits = foundEdits;
      owner = foundOwner;
      dispute = foundDispute;
      hasPasskey = passkey !== null;
    }
  } catch (error) {
    return <Notice text={t("error", { reason: reason(error) })} tone="failed" />;
  }

  if (passport === null) {
    return <Notice text={t("notFound")} />;
  }

  // The picture and the transaction links are the two things this page can do
  // without, so neither is allowed to fail the render.
  const [art, indexed] = await Promise.all([readArt(passport.metadataURI), indexedAttestations(passport.id)]);
  const standing = standingOf({ disputed: passport.disputed, attestations });

  return (
    <article>
      <Poster passport={passport} art={art} standing={standing} locale={locale} />

      <Attestations attestations={attestations} indexed={indexed} locale={locale} />

      <Facts passport={passport} art={art} owner={owner} hasPasskey={hasPasskey} />

      <div className="mx-auto w-full max-w-[1400px] px-5 pb-24 sm:px-8 sm:pb-32">
        {dispute === null ? null : (
          <div className="mb-16 rise">
            <DisputeNote dispute={dispute} locale={locale} />
          </div>
        )}

        <div className="grid gap-12 border-t border-line pt-14 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-20">
          <div className="rise">
            <Lineage parentId={passport.parentId} edits={edits} />
          </div>
          <div className="rise" style={{ animationDelay: "90ms" }}>
            <CheckCopy passportId={passport.id} />
          </div>
        </div>
      </div>
    </article>
  );
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
