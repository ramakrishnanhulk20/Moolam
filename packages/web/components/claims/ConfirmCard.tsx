"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useFormatter, useTranslations } from "next-intl";
import type { Hex } from "viem";
import { UseBlock } from "@/components/consent/Marks";
import { UseRows } from "@/components/consent/UseRows";
import { choiceOf } from "@/components/consent/draft";
import { WarningMark } from "@/components/WarningMark";
import { WaitLabel } from "@/components/studio/WaitLabel";
import { MONAD_EXPLORER, shortHex } from "@/lib/chain/client";
import type { ClaimTerms } from "@/lib/claims/client";
import { draftFromTerms } from "@/lib/claims/offers";
import type { ConfirmRow, ConfirmStep } from "@/lib/claims/useClaimConfirm";
import type { ConsentFailure } from "@/lib/consent/failure";

/**
 * The confirm step, drawn: the exact pictures the press sends, the exact terms
 * it writes, one button, and every state after it (P37). Nothing here reads or
 * sends; ClaimConfirm hands it the state, and a test hands it a fixture.
 */
export function ConfirmCard({
  rows,
  terms,
  step,
  failure,
  txHash,
  onConfirm,
  onRecheck,
  onReread,
}: {
  rows: ConfirmRow[];
  terms: ClaimTerms;
  step: ConfirmStep;
  failure: ConsentFailure | null;
  txHash?: Hex;
  onConfirm: () => void;
  onRecheck: () => void;
  onReread: () => void;
}) {
  const t = useTranslations("claims");
  const consent = useTranslations("passport.consent");
  const studio = useTranslations("studio");
  const format = useFormatter();
  const draft = draftFromTerms(terms);
  const choice = choiceOf(draft.consent);
  const busy = step === "checking" || step === "sending" || step === "confirming";
  const done = step === "done";

  return (
    <motion.article
      data-claims-confirm={step}
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.15 }}
      transition={{ duration: 0.65, ease: [0.16, 1, 0.3, 1] }}
      className="relative p-6 sm:p-8 lg:p-10"
    >
      {/* The accent rule down the leading edge: this is the one card that writes to the chain. */}
      <span aria-hidden className="absolute inset-y-0 start-0 w-[2px] bg-accent" />
      <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-accent">
        <span className="motif h-[9px] w-[9px]" />
        {t("count", { count: rows.length })}
      </p>
      <h3 className="mt-4 font-display text-[clamp(1.6rem,3vw,2.5rem)] font-semibold uppercase leading-[0.95] tracking-[-0.03em]">
        {t("confirm.heading")}
      </h3>
      <p className="mt-4 max-w-[58ch] text-base leading-relaxed text-text-muted">{t("confirm.line")}</p>

      <ul data-claims-confirm-rows className="mt-7 grid grid-cols-2 border-s border-t border-line sm:grid-cols-3 xl:grid-cols-4">
        {rows.map((row, index) => (
          <motion.li
            key={row.passportId}
            data-claims-confirm-row={row.passportId}
            initial={{ opacity: 0, y: 14 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{
              duration: 0.5,
              delay: Math.min(index, 6) * 0.05,
              ease: [0.16, 1, 0.3, 1],
            }}
            className="group border-e border-b border-line bg-bg-raised"
          >
            <div className="grain relative aspect-[4/3] overflow-hidden bg-bg-sunken">
              {row.art?.imageUrl === undefined ? (
                <span className="absolute inset-0 flex items-center justify-center font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">
                  {row.art === null ? "" : t("noPreview")}
                </span>
              ) : (
                // eslint-disable-next-line @next/next/no-img-element -- a pinned thumbnail through the site's gateway, drawn the way the grid below draws its own
                <img
                  src={row.art.imageUrl}
                  alt={row.art.title ?? ""}
                  loading="lazy"
                  className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.04]"
                />
              )}
              <div className="scrim pointer-events-none absolute inset-0" />
            </div>
            <div className="min-w-0 p-3.5">
              <p className="truncate text-sm text-text">{row.art?.title ?? studio("passports.untitled")}</p>
              <p className="mt-1 font-mono text-[11px] text-text-faint" title={row.passportId}>
                {shortHex(row.passportId, 8, 6)}
              </p>
              {row.platform === "" ? null : (
                <p className="mt-1 truncate font-mono text-[10px] uppercase tracking-[0.18em] text-text-faint">{row.platform}</p>
              )}
            </div>
          </motion.li>
        ))}
      </ul>

      <div data-claims-confirm-terms className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-10">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("confirm.termsLabel")}</p>
          <div className="mt-4 flex items-start gap-3">
            <UseBlock consent={draft.consent} size="h-3 w-3" className="mt-1.5 text-text" />
            <p className="font-display text-[1.15rem] font-semibold leading-[1.15] tracking-[-0.02em]">
              {choice === "custom" ? t("confirm.byUse") : consent(`control.choices.${choice}.title`)}
            </p>
          </div>
          {draft.constraintInfo.length === 0 ? null : (
            <blockquote className="mt-4 border-s-2 border-accent/50 ps-4 text-base leading-relaxed text-text-muted">
              <span className="block font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">
                {t("confirm.conditions")}
              </span>
              <span className="mt-1 block break-words">{draft.constraintInfo}</span>
            </blockquote>
          )}
        </div>
        <UseRows consent={draft.consent} />
      </div>

      <div className="mt-9 min-h-[3.5rem]">
        <AnimatePresence mode="wait" initial={false}>
          {done ? (
            <motion.div
              key="done"
              data-claims-done
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
              className="flex flex-wrap items-center gap-x-6 gap-y-3"
            >
              <p className="flex max-w-[52ch] items-start gap-3 font-display text-[1.25rem] font-semibold leading-[1.2] tracking-[-0.02em] text-text">
                <motion.span
                  aria-hidden
                  initial={{ rotate: -90, scale: 0 }}
                  animate={{ rotate: 0, scale: 1 }}
                  transition={{ type: "spring", stiffness: 260, damping: 18 }}
                  className="motif mt-1 h-5 w-5 shrink-0 bg-accent"
                />
                <span className="min-w-0">{t("confirm.done")}</span>
              </p>
              {txHash === undefined ? null : (
                <a
                  href={`${MONAD_EXPLORER}/tx/${txHash}`}
                  target="_blank"
                  rel="noreferrer"
                  className="tap font-mono text-[10px] uppercase tracking-[0.2em] text-text-muted underline decoration-line-strong underline-offset-4 transition-colors duration-200 hover:text-accent hover:decoration-accent"
                >
                  {t("confirm.receipt")}
                </a>
              )}
            </motion.div>
          ) : busy ? (
            <motion.div key="busy" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <WaitLabel text={t(`confirm.${step as "checking" | "sending" | "confirming"}`)} />
            </motion.div>
          ) : (
            <motion.div key="press" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <button
                type="button"
                data-claims-confirm-press
                disabled={rows.length === 0 || step === "changed" || failure?.next === "recheck"}
                onClick={onConfirm}
                className="rounded-[8px] bg-accent px-8 py-4 text-sm font-semibold uppercase tracking-[0.14em] text-accent-ink transition-transform duration-200 hover:-translate-y-0.5 disabled:translate-y-0 disabled:opacity-50"
              >
                {t("confirm.button", { count: rows.length })}
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {step === "changed" ? (
        <div role="alert" className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-3">
          <p className="flex max-w-[60ch] items-start gap-2.5 text-base leading-relaxed text-failed">
            <WarningMark className="mt-[5px] shrink-0" />
            <span className="min-w-0">{t("confirm.changed")}</span>
          </p>
          <NextButton label={t("confirm.readAgain")} onPress={onReread} />
        </div>
      ) : null}

      {step === "failed" && failure !== null ? (
        <div role="alert" data-claims-confirm-failure={failure.key} className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-3">
          {/* Closing the prompt is the person's own choice, so it is said plainly, never in the failure red. */}
          <p
            className={`flex max-w-[60ch] items-start gap-2.5 text-base leading-relaxed ${
              failure.key === "declined" ? "text-text-muted" : "text-failed"
            }`}
          >
            {failure.key === "declined" ? null : <WarningMark className="mt-[5px] shrink-0" />}
            <span className="min-w-0">
              {consent(`failure.${failure.key}`, {
                at:
                  failure.at === undefined
                    ? ""
                    : format.dateTime(new Date(failure.at * 1000), {
                        timeStyle: "short",
                      }),
              })}
            </span>
          </p>
          {failure.next === "again" ? <NextButton label={t("confirm.again")} onPress={onConfirm} /> : null}
          {failure.next === "recheck" ? <NextButton label={t("confirm.recheck")} onPress={onRecheck} /> : null}
          {failure.reason === undefined ? null : (
            <p className="basis-full break-words font-mono text-[11px] text-text-faint">{failure.reason}</p>
          )}
        </div>
      ) : null}
    </motion.article>
  );
}

function NextButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <button
      type="button"
      onClick={onPress}
      className="tap rounded-[8px] border border-line-strong px-4 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-text transition-colors duration-200 hover:border-accent hover:text-accent"
    >
      {label}
    </button>
  );
}
