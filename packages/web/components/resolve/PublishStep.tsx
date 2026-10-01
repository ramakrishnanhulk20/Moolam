"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useFormatter, useTranslations } from "next-intl";
import { useId } from "react";
import type { Hex } from "viem";
import { MONAD_EXPLORER, shortHex } from "@/lib/chain/client";
import { pinnedLink } from "@/lib/disputes/evidence";
import { MAX_REASONS_BYTES, reasonsBytes, reasonsText } from "@/lib/disputes/reasons";
import type { PublishState } from "@/lib/disputes/usePublishReasons";
import { WarningMark } from "@/components/WarningMark";
import { HEX_MARK, withHex } from "@/components/agents/hex";

/**
 * The step after a settle: write why, and publish it. The button says plainly
 * that this is one more transaction and what it is for, because the resolver
 * has just signed one and would otherwise think the decision was finished.
 * Done is said only once the publish's receipt carries its DecisionPublished
 * event; a publish that went out and has not shown is locked behind "look
 * again" and is never offered a second send.
 */
export function PublishStep({
  passportId,
  step,
  onText,
  onPublish,
  onRecheck,
}: {
  passportId: Hex;
  step: PublishState;
  onText: (text: string) => void;
  onPublish: () => void;
  onRecheck: () => void;
}) {
  const t = useTranslations("challenge.publish");
  const format = useFormatter();
  const calm = useReducedMotion() === true;
  const field = useId();

  if (step.phase === "done") {
    const link = step.reasonsURI === undefined ? null : pinnedLink(step.reasonsURI);
    return (
      <motion.div
        data-publish-step="done"
        data-passport={passportId}
        initial={calm ? false : { opacity: 0, y: 14 }}
        animate={calm ? undefined : { opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        className="mt-7 border-t border-line pt-6"
      >
        <p role="status" className="flex items-start gap-3 text-base leading-relaxed text-verified">
          <span aria-hidden className="motif mt-[7px] h-2 w-2 shrink-0 bg-verified" />
          <span className="min-w-0 max-w-[54ch]">{t("done")}</span>
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          {link === null ? null : (
            <a
              href={link}
              target="_blank"
              rel="noreferrer"
              className="rounded-[8px] border border-line px-5 py-3 text-xs uppercase tracking-[0.16em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent"
            >
              {t("openReasons")}
            </a>
          )}
          {step.hash === undefined ? null : (
            <a
              href={`${MONAD_EXPLORER}/tx/${step.hash}`}
              target="_blank"
              rel="noreferrer"
              className="rounded-[8px] border border-line px-5 py-3 text-xs uppercase tracking-[0.16em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent"
            >
              {withHex(t("openTx", { hash: HEX_MARK }), shortHex(step.hash))}
            </a>
          )}
        </div>
      </motion.div>
    );
  }

  const busy = step.phase !== "idle";
  const left = MAX_REASONS_BYTES - reasonsBytes(reasonsText(step.text));

  return (
    <div data-publish-step={step.phase} data-passport={passportId} className="mt-7 border-t border-line pt-6">
      <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.2em] text-accent">
        <span aria-hidden className="motif h-2 w-2 bg-accent" />
        {t("kicker")}
      </p>

      <label
        htmlFor={field}
        className="mt-5 flex flex-wrap items-baseline justify-between gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint"
      >
        <span>{t("label")}</span>
        <span className={`tabular-nums ${left < 0 ? "text-failed" : ""}`}>{t("left", { left: format.number(left) })}</span>
      </label>
      <textarea
        id={field}
        value={step.text}
        rows={6}
        disabled={busy}
        onChange={(event) => onText(event.target.value)}
        placeholder={t("placeholder")}
        className="mt-2 w-full resize-y border border-line bg-bg px-4 py-3 text-base leading-relaxed text-text outline-none transition-colors duration-200 placeholder:text-text-faint focus:border-accent disabled:opacity-60"
      />
      <p className="mt-2 max-w-[58ch] text-base leading-relaxed text-text-faint">{t("hint")}</p>

      <div className="mt-6 grid gap-4 lg:grid-cols-[auto_minmax(0,1fr)] lg:items-center lg:gap-8">
        <button
          type="button"
          onClick={onPublish}
          disabled={busy}
          className="w-full rounded-[8px] bg-accent px-6 py-3.5 text-xs font-semibold uppercase tracking-[0.16em] text-accent-ink transition-transform duration-200 hover:-translate-y-0.5 disabled:translate-y-0 disabled:opacity-50 sm:w-auto"
        >
          {t("button")}
        </button>
        <p data-publish-why className="max-w-[58ch] border-s-2 border-accent ps-4 text-base leading-relaxed text-text-muted">
          {t("why")}
        </p>
      </div>

      <AnimatePresence initial={false} mode="wait">
        {busy && step.phase !== "pending" ? (
          <motion.p
            key={step.phase}
            role="status"
            initial={calm ? false : { opacity: 0, y: 6 }}
            animate={calm ? undefined : { opacity: 1, y: 0 }}
            exit={calm ? undefined : { opacity: 0, y: -6 }}
            transition={{ duration: 0.25 }}
            className="mt-5 flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.16em] text-pending"
          >
            <span aria-hidden className="motif h-2 w-2 motion-safe:animate-pulse bg-pending" />
            {t(`states.${step.phase}`)}
          </motion.p>
        ) : null}
      </AnimatePresence>

      {step.phase === "pending" ? (
        <div role="status" data-tone="pending" className="mt-5 max-w-[58ch] border-s-2 border-text-muted bg-text-muted/5 py-3 ps-4">
          <p className="text-base leading-relaxed text-text-muted">{t("states.pending")}</p>
          <button
            type="button"
            onClick={onRecheck}
            className="mt-4 rounded-[8px] border border-line px-4 py-2 text-[11px] uppercase tracking-[0.18em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent"
          >
            {t("recheck")}
          </button>
        </div>
      ) : null}

      {step.refusal === null ? null : (
        <p
          role={step.refusal === "declined" ? "status" : "alert"}
          data-publish-refusal={step.refusal}
          className={`mt-5 flex max-w-[58ch] items-start gap-2.5 border-s-2 py-3 ps-4 text-base leading-relaxed ${
            step.refusal === "declined" ? "border-text-muted text-text-muted" : "border-failed bg-failed/10 text-failed"
          }`}
        >
          {step.refusal === "declined" ? null : <WarningMark className="mt-[5px]" />}
          <span className="min-w-0">{t(`refusals.${step.refusal}`)}</span>
        </p>
      )}
    </div>
  );
}
