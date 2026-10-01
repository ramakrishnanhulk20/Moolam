"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import type { Use, UseField } from "@/lib/chain/consent";
import { USE_FIELDS } from "@/lib/chain/consent";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import { UseBlock, UseMark } from "./Marks";
import {
  CHOICES,
  MAX_INFO_BYTES,
  choiceOf,
  consentForChoice,
  infoBytes,
  needsConditions,
  unprintableAt,
  type ConsentDraft,
} from "./draft";
import { USE_TONES } from "./tones";
import { WarningMark } from "@/components/WarningMark";

/** The order the four values are offered in: the two plain answers first, then the two careful ones. */
const VALUES: Use[] = ["allowed", "notAllowed", "constrained", "unspecified"];

/**
 * How a holder says what AI may do with their picture.
 *
 * Three plain choices, because almost nobody wants to think about four
 * independent uses, and a way in for the person who does. The conditions field
 * exists only while a choice needs one, and it counts the bytes the contract
 * counts, so the limit is visible while it is being filled rather than at the
 * moment a transaction fails.
 *
 * It sends nothing and holds nothing. The statement being built belongs to
 * whoever mounts this.
 */
export function ConsentChoice({
  draft,
  onChange,
  disabled = false,
  size = "regular",
  className = "",
}: {
  draft: ConsentDraft;
  onChange: (draft: ConsentDraft) => void;
  /** True while a statement is out, when nothing may be changed under it. */
  disabled?: boolean;
  /**
   * "compact" is the same three plates a size down, for the studio, where this
   * sits inside a form with a picture and a title above it rather than being the
   * whole card. Same words, same marks, same behaviour: only the air changes.
   */
  size?: "regular" | "compact";
  className?: string;
}) {
  const t = useTranslations("passport.consent");
  const reduced = useIsReducedMotion();
  const [open, setOpen] = useState(false);
  // My pictures can hold one of these per platform, so a fixed id would point every label at the first field.
  const conditionsId = useId();
  const small = size === "compact";

  const chosen = choiceOf(draft.consent);
  const wantsConditions = needsConditions(draft.consent);
  const bytes = infoBytes(draft.constraintInfo);
  const over = bytes > MAX_INFO_BYTES;
  const unprintable = unprintableAt(draft.constraintInfo);

  const setUse = (field: UseField, use: Use) =>
    onChange({ ...draft, consent: { ...draft.consent, [field]: use } });

  return (
    <div className={className}>
      <div className={`grid sm:grid-cols-3 ${small ? "gap-2" : "gap-3"}`}>
        {CHOICES.map((choice) => {
          const picked = chosen === choice;
          return (
            <button
              key={choice}
              type="button"
              disabled={disabled}
              onClick={() => onChange({ consent: consentForChoice(choice), constraintInfo: draft.constraintInfo })}
              aria-pressed={picked}
              data-choice={choice}
              className={`group relative flex flex-col overflow-hidden rounded-[8px] border text-start transition-all duration-200 disabled:opacity-60 ${
                small ? "p-3.5" : "p-5"
              } ${
                picked
                  ? "border-accent bg-accent-soft"
                  : "border-line bg-bg-raised hover:-translate-y-0.5 hover:border-line-strong"
              }`}
            >
              {picked ? (
                <motion.span
                  layoutId="consent-choice"
                  aria-hidden
                  className="absolute inset-x-0 top-0 h-[2px] bg-accent"
                  transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 34 }}
                />
              ) : null}

              <UseBlock
                consent={consentForChoice(choice)}
                size={small ? "h-2.5 w-2.5" : "h-3 w-3"}
                className={picked ? "text-text" : "text-text-faint"}
              />
              <span
                className={`block font-display font-semibold leading-[1.1] tracking-[-0.02em] ${
                  small ? "mt-3 text-[0.95rem]" : "mt-4 text-[1.05rem]"
                }`}
              >
                {t(`control.choices.${choice}.title`)}
              </span>
              <span
                className={`block max-w-[34ch] leading-relaxed text-text-muted ${
                  small ? "mt-1.5 text-sm" : "mt-2 text-base"
                }`}
              >
                {t(`control.choices.${choice}.line`)}
              </span>
            </button>
          );
        })}
      </div>

      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        className={`tap group flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint transition-colors duration-200 hover:text-accent ${
          small ? "mt-5" : "mt-8"
        }`}
      >
        <span aria-hidden className="h-px w-8 bg-line-strong transition-colors duration-200 group-hover:bg-accent" />
        {open ? t("control.oneAnswer") : t("control.byUse")}
        {chosen === "custom" ? <span className="text-accent">{t("control.byUseOn")}</span> : null}
      </button>

      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            key="uses"
            initial={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, height: "auto" }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
            transition={reduced ? { duration: 0.15 } : { duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            <ul className="mt-5">
              {USE_FIELDS.map((field) => (
                <li
                  key={field}
                  className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t border-line py-4"
                >
                  <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">
                    {t(`uses.${field}`)}
                  </span>
                  <span className="flex flex-wrap gap-px bg-line">
                    {VALUES.map((value) => {
                      const picked = draft.consent[field] === value;
                      return (
                        <button
                          key={value}
                          type="button"
                          disabled={disabled}
                          onClick={() => setUse(field, value)}
                          aria-pressed={picked}
                          className={`tap flex items-center gap-2 px-3 py-2.5 transition-colors duration-200 disabled:opacity-60 ${
                            picked ? `bg-accent-soft ${USE_TONES[value]}` : "bg-bg text-text-faint hover:text-text"
                          }`}
                        >
                          <UseMark state={value} className="h-3 w-3" />
                          <span className="text-[11px] leading-none">{t(`state.${value}`)}</span>
                        </button>
                      );
                    })}
                  </span>
                </li>
              ))}
            </ul>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {wantsConditions ? (
          <motion.div
            key="conditions"
            initial={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, height: "auto" }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
            transition={reduced ? { duration: 0.15 } : { duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            <div className={`border-s-2 border-accent/50 ps-5 ${small ? "mt-6" : "mt-8"}`}>
              <label htmlFor={conditionsId} className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">
                {t("control.conditionsLabel")}
              </label>
              <textarea
                id={conditionsId}
                rows={2}
                value={draft.constraintInfo}
                disabled={disabled}
                onChange={(event) => onChange({ ...draft, constraintInfo: event.target.value })}
                placeholder={t("control.conditionsPlaceholder")}
                className="mt-3 w-full rounded-[8px] border border-line bg-bg-raised p-4 text-base leading-relaxed text-text outline-none transition-colors duration-200 placeholder:text-text-faint hover:border-line-strong focus:border-accent disabled:opacity-60"
              />

              <div className="mt-3 flex items-center gap-4">
                <span aria-hidden className="relative h-px flex-1 bg-line">
                  <span
                    className={`absolute inset-y-0 start-0 ${over ? "bg-failed" : "bg-accent"}`}
                    style={{ width: `${Math.min(100, (bytes / MAX_INFO_BYTES) * 100)}%` }}
                  />
                </span>
                <span
                  className={`shrink-0 font-mono text-[10px] uppercase tracking-[0.18em] tabular-nums ${
                    over ? "text-failed" : "text-text-faint"
                  }`}
                >
                  {t("control.bytes", { bytes, max: MAX_INFO_BYTES })}
                </span>
              </div>

              {unprintable === null ? null : (
                <p className="mt-3 flex max-w-[52ch] items-start gap-2.5 text-base leading-relaxed text-failed">
                  <WarningMark className="mt-[5px]" />
                  {t("control.notPrintable", { at: unprintable + 1 })}
                </p>
              )}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
