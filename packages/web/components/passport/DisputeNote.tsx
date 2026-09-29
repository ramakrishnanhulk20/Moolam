import { getFormatter, getTranslations } from "next-intl/server";
import { formatEther, type Hex } from "viem";
import { MONAD_EXPLORER, shortHex } from "@/lib/chain/client";
import { DisputeStatus, type Dispute } from "@/lib/chain/registry";
import { evidenceMatches, reasonFrom } from "@/lib/disputes/evidence";
import { indexAvailable, indexedDispute } from "@/lib/disputes/indexed";
import { Link } from "@/lib/i18n/routing";
import { Mono } from "./Mono";

const STATUS_NAMES: Record<number, string> = {
  [DisputeStatus.Open]: "open",
  [DisputeStatus.Upheld]: "upheld",
  [DisputeStatus.Rejected]: "rejected",
};

/** What the challenger said, when the index has it and the chain's hash agrees. */
interface Evidence {
  reason: string | null;
  uri: string | null;
}

/**
 * A challenge against this passport, with the bond behind it and the words the
 * challenger put their money on.
 *
 * Only shown when there is one: a passport nobody has challenged says nothing
 * here rather than printing an empty dispute box, which would read like an
 * accusation on every page.
 *
 * The reason lives in the evidence URI, which the registry keeps only as a
 * hash, so it is read from the index and then checked against that hash. An
 * index that is behind, missing or wrong costs the sentence and never the box.
 */
export async function DisputeNote({
  dispute,
  passportId,
  locale,
}: {
  dispute: Dispute;
  passportId: Hex;
  locale: string;
}) {
  const t = await getTranslations("passport.dispute");
  const format = await getFormatter({ locale });
  const status = STATUS_NAMES[dispute.status] ?? "open";
  const evidence = await evidenceFor(passportId, dispute.evidenceHash);

  return (
    <section className="border-s-2 border-disputed bg-disputed/5 p-6 sm:p-8">
      <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-disputed">{t("kicker")}</p>
      <h2 className="mt-4 max-w-[24ch] font-display text-[clamp(1.3rem,2.4vw,1.9rem)] font-semibold leading-[1.05] tracking-[-0.03em]">
        {t(`status.${status}`)}
      </h2>
      <p className="mt-4 max-w-[52ch] text-base leading-relaxed text-text-muted">{t("body")}</p>

      {evidence !== null && evidence.reason !== null ? (
        <figure className="mt-7 max-w-[58ch] border-s-2 border-disputed/60 ps-5">
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("reason")}</p>
          <blockquote className="mt-2.5 text-base leading-relaxed text-text">{evidence.reason}</blockquote>
        </figure>
      ) : null}

      {evidence !== null && evidence.reason === null && evidence.uri !== null ? (
        <p className="tap-row mt-7 max-w-[58ch] text-base leading-relaxed text-text-muted">
          {t("evidenceElsewhere")}{" "}
          <a
            href={evidence.uri}
            target="_blank"
            rel="noreferrer"
            className="break-all underline decoration-line underline-offset-4 transition-colors duration-200 hover:text-accent"
          >
            {evidence.uri}
          </a>
        </p>
      ) : null}

      <dl className="mt-7 grid gap-x-8 gap-y-5 border-t border-line pt-5 sm:grid-cols-3">
        <div className="min-w-0">
          <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("challenger")}</dt>
          <dd className="tap-row mt-1.5 break-all font-mono text-sm">
            <a
              href={`${MONAD_EXPLORER}/address/${dispute.challenger}`}
              target="_blank"
              rel="noreferrer"
              className="transition-colors duration-200 hover:text-accent"
            >
              {shortHex(dispute.challenger)}
            </a>
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("bond")}</dt>
          <dd className="mt-1.5 font-mono text-sm">{t("mon", { amount: formatEther(dispute.bond) })}</dd>
        </div>
        <div className="min-w-0">
          <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("openedAt")}</dt>
          <dd className="mt-1.5 font-mono text-sm">
            {format.dateTime(new Date(Number(dispute.openedAt) * 1000), "moment")}
          </dd>
        </div>
      </dl>

      <p className="tap-row mt-6 flex flex-wrap items-center gap-x-3 gap-y-2 text-base leading-relaxed">
        <span aria-hidden className={dispute.status === DisputeStatus.Open ? "h-2 w-2 motion-safe:animate-pulse bg-disputed" : "h-2 w-2 bg-disputed"} />
        <span className={dispute.status === DisputeStatus.Open ? "text-text-muted" : "text-text"}>
          {dispute.status === DisputeStatus.Open ? t("waiting") : t(`outcome.${status}`)}
        </span>
        {/* The way from a challenged record to the desk that settles it. The
            console turns everybody but the resolver away by itself, so nobody
            is kept from seeing where the decision is made. */}
        <Link
          href="/resolve"
          className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint underline decoration-line underline-offset-4 transition-colors duration-200 hover:text-accent hover:decoration-accent"
        >
          {t("console")}
        </Link>
      </p>

      <p className="mt-6 font-mono text-[11px] text-text-faint">
        {t("evidence")} <Mono value={dispute.evidenceHash} />
      </p>
    </section>
  );
}

/**
 * The challenger's own words, read from the index and checked against the hash
 * on the record.
 *
 * The check is the point. The index is a mirror of the log, and printing text
 * from a mirror next to an accusation without proving it is the text that was
 * hashed would let a wrong index put words in somebody's mouth.
 */
async function evidenceFor(passportId: Hex, hash: Hex): Promise<Evidence | null> {
  if (!indexAvailable()) {
    return null;
  }

  try {
    const row = await indexedDispute(passportId);
    if (row === null || !evidenceMatches(row.evidenceURI, hash)) {
      return null;
    }
    return {
      reason: reasonFrom(row.evidenceURI),
      uri: row.evidenceURI,
    };
  } catch {
    return null;
  }
}
