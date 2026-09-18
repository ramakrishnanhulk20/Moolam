"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import type { Consent, Use, UseField } from "@/lib/chain/consent";
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
import { USE_LABELS, USE_STATES, USE_TONES } from "./words";

/** The order the four values are offered in: the two plain answers first, then the two careful ones. */
const VALUES: Use[] = ["allowed", "notAllowed", "constrained", "unspecified"];

/**
 * How a creator says what AI may do with their picture.
 *
 * Three plain choices, because almost nobody wants to think about four
 * independent uses, and a way in for the person who does. The conditions field
 * exists only while a choice needs one, and it counts the bytes the contract
 * counts, so the limit is visible while it is being filled rather than at the
 * moment a transaction fails.
 *
 * It sends nothing. What the creator has built is handed up through onChange,
 * and whoever mounts this decides what to do with it.
 */
export function ConsentChoice({
  variant,
  onChange,
  className = "",
}: {
  /** Two drawings of the same three choices: plates side by side, or stops along a rule. */
  variant: "plates" | "rule";
  onChange?: (draft: ConsentDraft) => void;
  className?: string;
}) {
  const reduced = useIsReducedMotion();
  const [consent, setConsent] = useState<Consent>(() => consentForChoice("closed"));
  const [info, setInfo] = useState("");
  const [open, setOpen] = useState(false);

  const chosen = choiceOf(consent);
  const wantsConditions = needsConditions(consent);
  const bytes = infoBytes(info);
  const over = bytes > MAX_INFO_BYTES;
  const unprintable = unprintableAt(info);

  // Held in a ref rather than watched: a caller who writes the handler inline
  // would otherwise hand this effect a new function on every render, and the
  // effect would keep waking itself up.
  const notify = useRef(onChange);
  useEffect(() => {
    notify.current = onChange;
  });

  useEffect(() => {
    notify.current?.({ consent, constraintInfo: wantsConditions ? info : "" });
  }, [consent, info, wantsConditions]);

  const setUse = (field: UseField, use: Use) => setConsent((held) => ({ ...held, [field]: use }));

  return (
    <div className={className}>
      {variant === "plates" ? (
        <div className="grid gap-3 sm:grid-cols-3">
          {CHOICES.map((choice) => {
            const picked = chosen === choice.key;
            return (
              <button
                key={choice.key}
                type="button"
                onClick={() => setConsent(consentForChoice(choice.key))}
                aria-pressed={picked}
                className={`group relative overflow-hidden rounded-[8px] border p-5 text-start transition-all duration-200 ${
                  picked
                    ? "border-accent bg-accent-soft"
                    : "border-line bg-bg-raised hover:-translate-y-0.5 hover:border-line-strong"
                }`}
              >
                {picked ? (
                  <motion.span
                    layoutId={`consent-choice-${variant}`}
                    aria-hidden
                    className="absolute inset-x-0 top-0 h-[2px] bg-accent"
                    transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 34 }}
                  />
                ) : null}

                <UseBlock
                  consent={consentForChoice(choice.key)}
                  size="h-3 w-3"
                  className={picked ? "text-text" : "text-text-faint"}
                />
                <span className="mt-4 block font-display text-[1.05rem] font-semibold leading-[1.1] tracking-[-0.02em]">
                  {choice.title}
                </span>
                <span className="mt-2 block max-w-[34ch] text-xs leading-relaxed text-text-muted">{choice.line}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="relative pt-2">
          <div aria-hidden className="absolute inset-x-[16%] top-[1.45rem] h-px bg-line" />
          <div className="relative grid grid-cols-3">
            {CHOICES.map((choice) => {
              const picked = chosen === choice.key;
              return (
                <button
                  key={choice.key}
                  type="button"
                  onClick={() => setConsent(consentForChoice(choice.key))}
                  aria-pressed={picked}
                  className="group flex flex-col items-center gap-3 px-1 text-center"
                >
                  <span
                    aria-hidden
                    className={`h-3.5 w-3.5 border transition-colors duration-200 ${
                      picked ? "border-accent bg-accent" : "border-line-strong bg-bg group-hover:border-accent"
                    }`}
                  />
                  <span
                    className={`font-display text-[0.95rem] font-semibold leading-[1.15] tracking-[-0.02em] transition-colors duration-200 ${
                      picked ? "text-text" : "text-text-muted group-hover:text-text"
                    }`}
                  >
                    {choice.title}
                  </span>
                  <UseBlock
                    consent={consentForChoice(choice.key)}
                    size="h-2.5 w-2.5"
                    className={picked ? "text-text" : "text-text-faint"}
                  />
                  <span className="hidden max-w-[28ch] text-xs leading-relaxed text-text-faint sm:block">
                    {choice.line}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        className="tap group mt-8 flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint transition-colors duration-200 hover:text-accent"
      >
        <span aria-hidden className="h-px w-8 bg-line-strong transition-colors duration-200 group-hover:bg-accent" />
        {open ? "one answer for all four" : "answer use by use"}
        {chosen === "custom" ? <span className="text-accent">in use</span> : null}
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
                    {USE_LABELS[field]}
                  </span>
                  <span className="flex flex-wrap gap-px bg-line">
                    {VALUES.map((value) => {
                      const picked = consent[field] === value;
                      return (
                        <button
                          key={value}
                          type="button"
                          onClick={() => setUse(field, value)}
                          aria-pressed={picked}
                          className={`tap flex items-center gap-2 px-3 py-2.5 transition-colors duration-200 ${
                            picked ? `bg-accent-soft ${USE_TONES[value]}` : "bg-bg text-text-faint hover:text-text"
                          }`}
                        >
                          <UseMark state={value} className="h-3 w-3" />
                          <span className="text-[11px] leading-none">{USE_STATES[value]}</span>
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
            <div className="mt-8 border-s-2 border-accent/50 ps-5">
              <label
                htmlFor={`conditions-${variant}`}
                className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint"
              >
                Conditions, in your words
              </label>
              <textarea
                id={`conditions-${variant}`}
                rows={2}
                value={info}
                onChange={(event) => setInfo(event.target.value)}
                placeholder="A licence, a page to read, or an address to ask at."
                className="mt-3 w-full rounded-[8px] border border-line bg-bg-raised p-4 text-sm leading-relaxed text-text outline-none transition-colors duration-200 placeholder:text-text-faint hover:border-line-strong focus:border-accent"
              />

              <div className="mt-3 flex items-center gap-4">
                <span aria-hidden className="relative h-px flex-1 bg-line">
                  <span
                    className={`absolute inset-y-0 start-0 ${over ? "bg-failed" : "bg-accent"}`}
                    style={{ width: `${Math.min(100, (bytes / MAX_INFO_BYTES) * 100)}%` }}
                  />
                </span>
                <span
                  className={`shrink-0 font-mono text-[10px] uppercase tracking-[0.18em] ${
                    over ? "text-failed" : "text-text-faint"
                  }`}
                >
                  {bytes} of {MAX_INFO_BYTES} bytes
                </span>
              </div>

              {unprintable === null ? null : (
                <p className="mt-3 max-w-[52ch] text-xs leading-relaxed text-failed">
                  The register takes plain ASCII only. Character {unprintable + 1} is not one the chain will accept, so a
                  line break or an accented letter has to go before this can be written.
                </p>
              )}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
