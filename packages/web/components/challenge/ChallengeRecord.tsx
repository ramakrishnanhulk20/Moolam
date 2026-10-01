import { useFormatter, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { formatEther, type Hex } from "viem";
import { MONAD_EXPLORER, shortHex } from "@/lib/chain/client";
import { DisputeStatus, type Dispute } from "@/lib/chain/registry";
import { pinnedLink } from "@/lib/disputes/evidence";
import { answerOpen } from "@/lib/disputes/standing";
import { Link } from "@/lib/i18n/routing";
import { Mono } from "@/components/passport/Mono";
import { AnswerShown, type AnswerStanding } from "./AnswerShown";
import { HolderAnswer } from "./HolderAnswer";

const STATUS_NAMES: Record<number, string> = {
  [DisputeStatus.Open]: "open",
  [DisputeStatus.Upheld]: "upheld",
  [DisputeStatus.Rejected]: "rejected",
};

/** What the challenger said, when the index has it and the chain's hash agrees. */
export interface ChallengeEvidence {
  reason: string | null;
  uri: string | null;
}

/**
 * One challenge on a passport, drawn from what the page already read: the
 * record, the challenger's words, the holder's answer and, once settled, the
 * decision. Nothing here reads anything, so a test draws it from fixtures and
 * the page draws it from the chain.
 *
 * The claim and the answer face each other, two sides of one argument, so a
 * reader sees both before the verdict under them.
 */
export function ChallengeRecord({
  passportId,
  dispute,
  evidence,
  answer,
  decision = null,
}: {
  passportId: Hex;
  dispute: Dispute;
  evidence: ChallengeEvidence | null;
  answer: AnswerStanding;
  /** The decision block, once the dispute is settled. */
  decision?: ReactNode;
}) {
  const t = useTranslations("passport.dispute");
  const format = useFormatter();
  const status = STATUS_NAMES[dispute.status] ?? "open";
  const open = dispute.status === DisputeStatus.Open;

  const claim = claimSide(evidence, t);
  const shown = <AnswerShown standing={answer} />;
  const answerSide = answerOpen(answer) ? (
    <HolderAnswer
      passportId={passportId}
      dispute={{ challenger: dispute.challenger, openedAt: Number(dispute.openedAt) }}
      until={answer.until}
      fallback={shown}
    />
  ) : answer.kind === "none" ? null : (
    shown
  );

  return (
    <section data-challenge-record={status} className="border-s-2 border-disputed bg-disputed/5 p-6 sm:p-8">
      <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-disputed">{t("kicker")}</p>
      <h2 className="mt-4 max-w-[24ch] font-display text-[clamp(1.3rem,2.4vw,1.9rem)] font-semibold leading-[1.05] tracking-[-0.03em]">
        {t(`status.${status}`)}
      </h2>
      <p className="mt-4 max-w-[52ch] text-base leading-relaxed text-text-muted">{open ? t("body") : t("bodySettled")}</p>

      {claim === null && answerSide === null ? null : (
        <div
          data-challenge-sides
          className={`mt-8 grid gap-10 border-t border-line pt-7 ${
            claim !== null && answerSide !== null ? "lg:grid-cols-2 lg:gap-0" : ""
          }`}
        >
          {claim === null ? null : <div className="rise min-w-0 lg:pe-10">{claim}</div>}
          {answerSide === null ? null : (
            <div
              data-answer-side
              className={`rise min-w-0 ${claim === null ? "" : "lg:border-s lg:border-line lg:ps-10"}`}
              style={{ animationDelay: "90ms" }}
            >
              {answerSide}
            </div>
          )}
        </div>
      )}

      <dl className="mt-8 grid gap-x-8 gap-y-5 border-t border-line pt-5 sm:grid-cols-3">
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

      {decision}

      <p className="tap-row mt-6 flex flex-wrap items-center gap-x-3 gap-y-2 text-base leading-relaxed">
        <span aria-hidden className={open ? "motif h-2 w-2 motion-safe:animate-pulse bg-disputed" : "motif h-2 w-2 bg-disputed"} />
        <span className={open ? "text-text-muted" : "text-text"}>{open ? t("waiting") : t(`outcome.${status}`)}</span>
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
 * The challenger's side: their words when the evidence carries them, else the
 * address they gave. That address is a stranger's, so it becomes a link only
 * as ipfs://<cid> and is drawn as plain text otherwise (L29).
 */
function claimSide(evidence: ChallengeEvidence | null, t: (key: string) => string): ReactNode {
  if (evidence === null) {
    return null;
  }
  if (evidence.reason !== null) {
    return (
      <figure data-claim className="max-w-[58ch] border-s-2 border-disputed/60 ps-5">
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("reason")}</p>
        <blockquote className="mt-2.5 whitespace-pre-line break-words text-base leading-relaxed text-text">
          {evidence.reason}
        </blockquote>
      </figure>
    );
  }
  if (evidence.uri === null) {
    return null;
  }
  const link = pinnedLink(evidence.uri);
  return (
    <p data-claim-elsewhere className="tap-row max-w-[58ch] text-base leading-relaxed text-text-muted">
      {t("evidenceElsewhere")}{" "}
      {link === null ? (
        <span data-evidence-text className="break-all font-mono text-sm text-text">
          {evidence.uri}
        </span>
      ) : (
        <a
          href={link}
          target="_blank"
          rel="noreferrer"
          data-evidence-link
          className="break-all underline decoration-line underline-offset-4 transition-colors duration-200 hover:text-accent"
        >
          {evidence.uri}
        </a>
      )}
    </p>
  );
}
