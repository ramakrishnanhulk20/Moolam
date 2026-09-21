"use client";

import { motion } from "framer-motion";
import { useFormatter, useTranslations } from "next-intl";
import { shortHex } from "@/lib/chain/client";
import { ConsentStamp } from "@/components/consent/ConsentStamp";
import { pictureSources } from "@/lib/images";
import { Mono } from "@/components/passport/Mono";
import { Picture } from "@/components/passport/Picture";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import { Link } from "@/lib/i18n/routing";
import { DisputeLine } from "./DisputeLine";
import { SecondOpinion } from "./SecondOpinion";
import { agentChipId, percent, type Answer, type Problem } from "./answer";
import type { MatchedPassport } from "./lookup";

/** What the card is showing right now. The first two are its front, the last two its back. */
export type Stage =
  | { kind: "idle" }
  | { kind: "checking"; name: string }
  | { kind: "answer"; answer: Answer; passport: MatchedPassport | null }
  | { kind: "problem"; problem: Problem };

const EASE = [0.16, 1, 0.3, 1] as const;

/**
 * The answer, on a card that turns over.
 *
 * A verify run takes a few seconds, so the wait is a face of its own with an
 * honest label on it, and the result arrives by turning the card rather than by
 * swapping text in place. Anyone who has asked for less motion gets a fade
 * between the same two faces.
 */
export function AnswerCard({ stage }: { stage: Stage }) {
  const reduced = useIsReducedMotion();
  const flipped = stage.kind === "answer" || stage.kind === "problem";

  return (
    <div style={{ perspective: 2000 }} className="w-full">
      <motion.div
        animate={reduced ? {} : { rotateY: flipped ? 180 : 0 }}
        transition={{ duration: 0.95, ease: EASE }}
        style={{ transformStyle: "preserve-3d", display: "grid" }}
        className="w-full"
      >
        <motion.div
          animate={reduced ? { opacity: flipped ? 0 : 1 } : {}}
          transition={{ duration: 0.3 }}
          style={{ gridArea: "1 / 1", backfaceVisibility: "hidden", pointerEvents: flipped ? "none" : "auto" }}
        >
          {stage.kind === "checking" ? <Checking name={stage.name} /> : <Idle />}
        </motion.div>

        <motion.div
          animate={reduced ? { opacity: flipped ? 1 : 0 } : {}}
          transition={{ duration: 0.3 }}
          style={{
            gridArea: "1 / 1",
            backfaceVisibility: "hidden",
            transform: reduced ? undefined : "rotateY(180deg)",
            pointerEvents: flipped ? "auto" : "none",
          }}
        >
          {stage.kind === "problem" ? (
            <Refused problem={stage.problem} />
          ) : stage.kind === "answer" ? (
            <Result answer={stage.answer} passport={stage.passport} />
          ) : (
            <Plate />
          )}
        </motion.div>
      </motion.div>
    </div>
  );
}

function Plate({ children, tone = "line" }: { children?: React.ReactNode; tone?: "line" | "verified" | "failed" }) {
  const edge = tone === "verified" ? "border-verified/40" : tone === "failed" ? "border-failed/40" : "border-line";
  return (
    <section className={`grain relative min-h-[24rem] overflow-hidden border ${edge} bg-bg-raised`}>{children}</section>
  );
}

function Idle() {
  const t = useTranslations("verify");
  const steps = ["fingerprint", "rotate", "search"] as const;

  return (
    <Plate>
      <div className="p-7 sm:p-9">
        <p className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.28em] text-text-faint">
          <span className="motif h-[9px] w-[9px] opacity-40" />
          {t("idleHeading")}
        </p>
        <p className="mt-5 max-w-[30ch] font-display text-[clamp(1.4rem,2.4vw,2rem)] font-semibold leading-[1.05] tracking-[-0.03em] text-text-muted">
          {t("idleBody")}
        </p>

        <ol className="mt-9 border-t border-line">
          {steps.map((step, index) => (
            <li key={step} className="flex items-start gap-5 border-b border-line py-4">
              <span className="mt-0.5 font-mono text-[11px] tabular-nums text-text-faint">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span className="text-sm leading-relaxed text-text-muted">{t(`steps.${step}`)}</span>
            </li>
          ))}
        </ol>
      </div>
    </Plate>
  );
}

function Checking({ name }: { name: string }) {
  const t = useTranslations("verify");
  const reduced = useIsReducedMotion();

  return (
    <Plate>
      {reduced ? null : (
        <motion.span
          aria-hidden
          initial={{ top: "0%" }}
          animate={{ top: ["0%", "100%"] }}
          transition={{ duration: 1.9, repeat: Infinity, ease: "easeInOut", repeatType: "reverse" }}
          className="pointer-events-none absolute inset-x-0 h-px bg-accent/70"
        />
      )}
      <div className="relative p-7 sm:p-9">
        <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-accent">
          <span className="inline-block h-2 w-2 animate-pulse bg-accent" />
          {t("pending")}
        </p>
        <p className="mt-6 max-w-[26ch] font-display text-[clamp(1.6rem,3vw,2.4rem)] font-semibold leading-[1.02] tracking-[-0.035em]">
          {t("checkingHeading")}
        </p>
        <p className="mt-5 max-w-[42ch] text-sm leading-relaxed text-text-muted">{t("checkingDetail")}</p>
        <p className="mt-8 break-all font-mono text-[11px] text-text-faint">{name}</p>
      </div>
    </Plate>
  );
}

function Result({ answer, passport }: { answer: Answer; passport: MatchedPassport | null }) {
  const t = useTranslations("verify");
  const agentId = agentChipId(passport);

  if (answer.kind === "miss") {
    return (
      <Plate tone="failed">
        <div className="p-7 sm:p-9">
          <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-failed">{t("noMatchLabel")}</p>
          <p className="mt-5 max-w-[18ch] font-display text-[clamp(2rem,4.4vw,3.2rem)] font-semibold uppercase leading-[0.92] tracking-[-0.04em]">
            {t("none")}
          </p>
          <p className="mt-5 max-w-[44ch] text-sm leading-relaxed text-text-muted">{t("noneHint")}</p>

          <Link
            href="/studio"
            className="mt-8 inline-block rounded-[8px] bg-accent px-6 py-3.5 text-xs font-semibold uppercase tracking-[0.16em] text-accent-ink transition-transform duration-200 hover:-translate-y-0.5"
          >
            {t("registerCta")}
          </Link>

          <Measured answer={answer} />
        </div>
      </Plate>
    );
  }

  return (
    <Plate tone="verified">
      <Still passport={passport} exact={answer.kind === "exact"} />

      <div className="p-7 sm:p-9">
        {/* The plain answer first, in the same words the passport page's drop
            gives. The confidence and the two distances are the working under it,
            not the verdict. */}
        <p className="max-w-[24ch] font-display text-[clamp(1.5rem,3vw,2.3rem)] font-semibold leading-[1.04] tracking-[-0.035em] text-verified">
          {answer.kind === "exact"
            ? t("verdictExact", { title: passport?.title ?? t("untitled") })
            : t("verdict", { title: passport?.title ?? t("untitled") })}
        </p>

        <div className="mt-7 flex flex-wrap items-end gap-x-6 gap-y-2">
          <p className="font-display text-[clamp(3.4rem,9vw,6rem)] font-semibold leading-[0.8] tracking-[-0.05em] tabular-nums text-accent">
            {percent(answer.confidence)}
            <span className="ps-1 align-top text-[0.28em] tracking-normal">%</span>
          </p>
          <p className="pb-2 font-mono text-[11px] uppercase tracking-[0.2em] text-text-faint">{t("confidence")}</p>
        </div>

        <dl className="mt-8 grid grid-cols-2 gap-x-8 gap-y-6 border-t border-line pt-7 sm:grid-cols-3">
          <Readout label={t("phashDistance")} value={t("bits", { count: answer.phashDistance, of: 64 })} />
          <Readout label={t("blockhashDistance")} value={t("bits", { count: answer.blockhashDistance, of: 256 })} />
          <Readout label={t("variant")} value={t(`orientation.${answer.variant}`)} />
        </dl>

        {answer.others === 0 ? null : (
          <p className="mt-6 text-sm leading-relaxed text-text-muted">{t("others", { count: answer.others })}</p>
        )}

        <p className="mt-6 max-w-[44ch] text-sm leading-relaxed text-text-muted">
          {answer.manifest ? t("manifestPresent") : t("manifestMissing")}
        </p>

        {/* Proving the picture is registered is half the answer. This is the
            other half, three facts that are read together: what the holder said
            about AI use, whether anybody has challenged the record that word
            rests on, and what an independent workflow found when it fetched the
            picture and hashed it again. */}
        <ConsentStamp consent={answer.consent} className="mt-8" />
        <DisputeLine dispute={answer.dispute} className="mt-4" />
        <SecondOpinion recheck={answer.recheck} id={answer.id} className="mt-6" />

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Link
            href={`/passport/${answer.id}`}
            className="rounded-[8px] bg-accent px-6 py-3.5 text-xs font-semibold uppercase tracking-[0.16em] text-accent-ink transition-transform duration-200 hover:-translate-y-0.5"
          >
            {t("openPassport")}
          </Link>
          {agentId === null ? null : (
            <Link
              href={`/agent/${agentId}`}
              className="rounded-[8px] border border-line px-5 py-3.5 text-xs uppercase tracking-[0.16em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent"
            >
              {t("openAgent", { id: agentId })}
            </Link>
          )}
        </div>

        <p className="mt-6 font-mono text-[11px] text-text-faint">
          <Mono value={answer.id} />
        </p>
        {passport === null ? <p className="mt-3 max-w-[44ch] text-sm text-text-muted">{t("lookupFailed")}</p> : null}

        <Measured answer={answer} />
      </div>
    </Plate>
  );
}

/** The matched passport as a film still, or the seal when IPFS will not hand the picture over. */
function Still({ passport, exact }: { passport: MatchedPassport | null; exact: boolean }) {
  const t = useTranslations("verify");
  const format = useFormatter();
  const kinds = useTranslations("kind");

  const seal = (
    <span className="absolute inset-0 flex flex-col items-center justify-center gap-3">
      <span className="motif h-5 w-5" />
      <span className="max-w-[28ch] px-6 text-center font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">
        {t("noPicture")}
      </span>
    </span>
  );

  return (
    <div className="grain relative aspect-[16/9] overflow-hidden border-b border-line bg-bg-sunken">
      {passport?.thumbnailUrl === undefined ? (
        seal
      ) : (
        // The pinned copy of the registered image, read back through the
        // optimizer so a second look at the same record costs no gateway read.
        <Picture
          sources={pictureSources(passport.thumbnailUrl)}
          sizes="(min-width: 1024px) 46vw, 100vw"
          className="object-cover"
          fallback={seal}
        />
      )}
      <div className="scrim pointer-events-none absolute inset-0" />

      <p className="absolute inset-x-0 top-0 flex items-center gap-3 p-5 font-mono text-[11px] uppercase tracking-[0.24em] text-verified">
        <span className="motif h-[9px] w-[9px]" />
        {exact ? t("exact") : t("matched")}
      </p>

      {passport === null ? null : (
        <div className="absolute inset-x-0 bottom-0 p-5">
          <p className="max-w-[28ch] font-display text-[clamp(1.2rem,2.4vw,1.9rem)] font-semibold leading-[1.05] tracking-[-0.03em]">
            {passport.title ?? t("untitled")}
          </p>
          <p className="mt-2 font-mono text-[11px] text-text-faint">
            {kinds(String(passport.kind))} <span className="mx-1">/</span>
            {format.dateTime(new Date(Number(passport.registeredAt) * 1000), { dateStyle: "medium" })}
          </p>
        </div>
      )}
    </div>
  );
}

/** What the service measured on the file it was handed. Proof the run really happened. */
function Measured({ answer }: { answer: Answer }) {
  const t = useTranslations("verify");
  const { queried } = answer;

  return (
    <div className="mt-10 border-t border-line pt-6">
      <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-text-faint">{t("measured")}</p>
      <dl className="mt-5 grid grid-cols-2 gap-x-8 gap-y-5">
        <Readout label={t("queriedSize")} value={`${queried.width} x ${queried.height} ${queried.format}`} />
        <Readout label={t("queriedPhash")} value={queried.phash} />
        <Readout label={t("queriedSha")} value={shortHex(queried.sha256, 10, 8)} />
        <Readout label={t("queriedBlockhash")} value={shortHex(queried.blockhash, 10, 8)} />
      </dl>
    </div>
  );
}

function Refused({ problem }: { problem: Problem }) {
  const t = useTranslations("verify");

  return (
    <Plate tone="failed">
      <div className="p-7 sm:p-9">
        <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-failed">{t("problemLabel")}</p>
        <p className="mt-5 max-w-[26ch] font-display text-[clamp(1.5rem,2.8vw,2.2rem)] font-semibold leading-[1.05] tracking-[-0.03em] text-failed">
          {t(problem.key)}
        </p>
        {problem.reason === undefined ? null : (
          <p className="mt-5 max-w-[46ch] break-words font-mono text-[11px] leading-relaxed text-text-faint">
            {problem.reason}
          </p>
        )}
      </div>
    </Plate>
  );
}

function Readout({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{label}</dt>
      <dd className="mt-1.5 text-sm text-text">
        <Mono value={value} />
      </dd>
    </div>
  );
}
