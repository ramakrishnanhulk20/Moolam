"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useFormatter, useTranslations } from "next-intl";
import { useId } from "react";
import { WarningMark } from "@/components/WarningMark";
import { MAX_ANSWER_BYTES, answerBytes, answerText } from "@/lib/disputes/answer";
import type { HolderAnswer } from "@/lib/disputes/useHolderAnswer";

/** The few fields of the hook the form draws, so a test can hand it a fixture. */
export type AnswerFormState = Pick<HolderAnswer, "text" | "phase" | "refusal" | "answerURI" | "sent" | "setText" | "submit">;

/**
 * The holder's answer form: what to write, how long it may be, and the one
 * button that has the wallet sign it. Every state is a line in words, and every
 * refusal says what to do next. Once the service holds the answer, the form
 * gives way to the words as they were signed.
 */
export function AnswerForm({ answer, until }: { answer: AnswerFormState; until: number }) {
  const t = useTranslations("challenge.answer");
  const shown = useTranslations("challenge.answer.shown");
  const format = useFormatter();
  const calm = useReducedMotion() === true;
  const field = useId();
  const date = format.dateTime(new Date(until * 1000), { dateStyle: "medium" });

  if (answer.phase === "done") {
    return (
      <motion.div
        data-answer-form="done"
        initial={calm ? false : { opacity: 0, y: 16 }}
        animate={calm ? undefined : { opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        className="min-w-0"
      >
        <p role="status" className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.2em] text-verified">
          <span aria-hidden className="motif h-2 w-2 bg-verified" />
          {t("states.done")}
        </p>
        <p className="mt-5 font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{shown("label")}</p>
        <blockquote className="mt-2.5 whitespace-pre-line break-words text-base leading-relaxed text-text">
          {answer.sent ?? ""}
        </blockquote>
      </motion.div>
    );
  }

  const busy = answer.phase === "signing" || answer.phase === "sending";
  const left = MAX_ANSWER_BYTES - answerBytes(answerText(answer.text));

  return (
    <div data-answer-form={answer.phase} className="min-w-0">
      <h3 className="font-display text-[clamp(1.25rem,2.2vw,1.7rem)] font-semibold uppercase leading-[1.02] tracking-[-0.03em]">
        {t("heading")}
      </h3>
      <p className="mt-4 max-w-[54ch] text-base leading-relaxed text-text-muted">{t("prompt", { date })}</p>

      <label htmlFor={field} className="mt-6 flex flex-wrap items-baseline justify-between gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">
        <span>{shown("label")}</span>
        <span data-answer-left className={`tabular-nums ${left < 0 ? "text-failed" : ""}`}>
          {t("left", { left: format.number(left) })}
        </span>
      </label>
      <textarea
        id={field}
        value={answer.text}
        rows={7}
        disabled={busy}
        onChange={(event) => answer.setText(event.target.value)}
        placeholder={t("placeholder")}
        className="mt-2 w-full resize-y border border-line bg-bg px-4 py-3 text-base leading-relaxed text-text outline-none transition-colors duration-200 placeholder:text-text-faint focus:border-disputed disabled:opacity-60"
      />
      <p className="mt-2 max-w-[54ch] text-base leading-relaxed text-text-faint">{t("hint")}</p>

      <button
        type="button"
        onClick={() => void answer.submit()}
        disabled={busy}
        className="mt-6 w-full rounded-[8px] bg-disputed px-6 py-3.5 text-xs font-semibold uppercase tracking-[0.16em] text-bg transition-transform duration-200 hover:-translate-y-0.5 disabled:translate-y-0 disabled:opacity-50 sm:w-auto"
      >
        {t("button")}
      </button>

      <AnimatePresence initial={false} mode="wait">
        {busy ? (
          <motion.p
            key={answer.phase}
            role="status"
            initial={calm ? false : { opacity: 0, y: 6 }}
            animate={calm ? undefined : { opacity: 1, y: 0 }}
            exit={calm ? undefined : { opacity: 0, y: -6 }}
            transition={{ duration: 0.25 }}
            className="mt-4 flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.16em] text-pending"
          >
            <span aria-hidden className="motif h-2 w-2 motion-safe:animate-pulse bg-pending" />
            {t(`states.${answer.phase}`)}
          </motion.p>
        ) : null}
      </AnimatePresence>

      {answer.refusal === null ? null : (
        <motion.p
          role={answer.refusal === "declined" ? "status" : "alert"}
          data-answer-refusal={answer.refusal}
          initial={calm ? false : { opacity: 0, y: 10 }}
          animate={calm ? undefined : { opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
          className={`mt-5 flex max-w-[54ch] items-start gap-2.5 border-s-2 py-3 ps-4 text-base leading-relaxed ${
            answer.refusal === "declined" ? "border-text-muted text-text-muted" : "border-failed bg-failed/10 text-failed"
          }`}
        >
          {answer.refusal === "declined" ? null : <WarningMark className="mt-[5px]" />}
          <span className="min-w-0">{t(`refusals.${answer.refusal}`)}</span>
        </motion.p>
      )}
    </div>
  );
}
