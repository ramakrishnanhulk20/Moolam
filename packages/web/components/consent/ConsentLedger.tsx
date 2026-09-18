"use client";

import { motion } from "framer-motion";
import { useEffect, useMemo, useState } from "react";
import { MONAD_EXPLORER, shortHex } from "@/lib/chain/client";
import { NOTHING_STATED, plainStatement } from "@/lib/chain/consent";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import { UseBlock } from "./Marks";
import { ConsentChip } from "./Summary";
import {
  daysAcross,
  fractionOf,
  secondsForDay,
  segmentAt,
  segmentsOf,
  type AskConsentAt,
  type LedgerAnswer,
  type LedgerEntry,
} from "./ledger";
import { SUMMARY_HEADLINES, SUMMARY_LINES, SUMMARY_TONES, dayText, momentText } from "./words";

/**
 * The card as a ledger: the passport's whole life as one rule, and a thumb that
 * asks the chain what was in force on the day it sits on.
 *
 * This is the question a label in a file cannot answer. A crawler that took a
 * picture in August and a holder who closed their work in September disagree
 * about what was allowed, and only a register that keeps every statement can
 * settle it. So the answer under the thumb is not computed from what the page
 * already knows: it is a fresh call to consentAt, and the date it comes back
 * with is the date the chain stands behind.
 */
export function ConsentLedger({
  registeredAt,
  now,
  entries,
  standing,
  ask,
  standard,
  className = "",
}: {
  /** When the picture was registered, in whole seconds. The rule starts here. */
  registeredAt: number;
  /** When this card was rendered, in whole seconds. The rule ends here. */
  now: number;
  entries: LedgerEntry[];
  /** What stands today, read on the server, so the card opens on an answer rather than a wait. */
  standing: LedgerAnswer;
  ask: AskConsentAt;
  standard: string;
  className?: string;
}) {
  const reduced = useIsReducedMotion();
  const lastDay = daysAcross(registeredAt, now);

  const segments = useMemo(() => segmentsOf(registeredAt, now, entries), [registeredAt, now, entries]);
  const [day, setDay] = useState(lastDay);
  const [answer, setAnswer] = useState<{ at: number; reading: LedgerAnswer }>({ at: now, reading: standing });
  const [asking, setAsking] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const asked = secondsForDay(day, registeredAt, now);

  useEffect(() => {
    if (asked === answer.at) {
      return;
    }

    const controller = new AbortController();
    // A short wait, so dragging the length of the rule is one or two calls
    // rather than one per day the thumb passed over.
    const timer = setTimeout(() => {
      setAsking(true);
      ask(asked, controller.signal)
        .then((reading) => {
          if (!controller.signal.aborted) {
            setAnswer({ at: asked, reading });
            setFailed(null);
          }
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) {
            setFailed(error instanceof Error ? error.message : String(error));
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setAsking(false);
          }
        });
    }, 160);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [asked, answer.at, ask]);

  const shown = answer.reading;
  const consent = shown.entry?.consent ?? NOTHING_STATED;
  const summary = shown.stated ? plainStatement(consent) : "none";
  const tone = SUMMARY_TONES[summary];
  const live = segmentAt(segments, asked);

  return (
    <section className={`border-y border-line bg-bg px-5 py-10 sm:px-8 sm:py-12 ${className}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-text-faint">The ledger</p>
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-text-faint">{standard}</p>
      </div>

      <div className="mt-8 grid gap-10 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:gap-14">
        <div className="min-w-0 min-h-[13rem]">
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">On this day, AI could</p>

          {/* Keyed on the moment asked, so a new answer settles in rather than
              swapping in place. The height above and below is reserved, so
              nothing on the page moves while the chain is being asked. */}
          <motion.div
            key={answer.at}
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 14 }}
            animate={{ opacity: asking ? 0.45 : 1, y: 0 }}
            transition={reduced ? { duration: 0.15 } : { duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
            className="mt-3"
          >
            <p className="font-display text-[clamp(1.6rem,3.6vw,2.8rem)] font-semibold leading-[0.98] tracking-[-0.03em]">
              {SUMMARY_HEADLINES[summary]}
            </p>
            <p className="mt-4 flex flex-wrap items-center gap-3">
              <span className="font-mono text-[11px] tracking-[0.14em] text-accent">{dayText(answer.at)}</span>
              <span aria-hidden className="h-px w-8 bg-line-strong" />
              <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-text-faint">
                {shown.stated ? `written ${momentText(shown.entry?.at ?? answer.at)}` : "nothing stated by then"}
              </span>
            </p>
            <p className="mt-4 max-w-[46ch] text-sm leading-relaxed text-text-muted">{SUMMARY_LINES[summary]}</p>
          </motion.div>

          <p className="mt-5 h-4 font-mono text-[10px] uppercase tracking-[0.2em]">
            {failed !== null ? (
              <span className="text-failed">the chain did not answer: {failed}</span>
            ) : asking ? (
              <span className="text-text-faint">asking the chain for that day</span>
            ) : null}
          </p>
        </div>

        <div className="min-w-0 min-h-[13rem] lg:border-s lg:border-line lg:ps-10">
          <UseBlock consent={consent} size="h-7 w-7" className={`gap-[5px] ${tone.ink}`} />

          <div className="mt-6 flex flex-wrap items-center gap-4">
            <ConsentChip summary={summary} />
          </div>

          {shown.entry !== null && shown.entry.constraintInfo.length > 0 ? (
            <p className="mt-6 max-w-[46ch] border-s-2 border-accent/50 ps-4 text-sm leading-relaxed break-words text-text">
              {shown.entry.constraintInfo}
            </p>
          ) : null}

          {shown.entry === null ? null : (
            <p className="tap-row mt-6 font-mono text-[10px] uppercase tracking-[0.18em] text-text-faint">
              by{" "}
              <a
                href={`${MONAD_EXPLORER}/address/${shown.entry.writer}`}
                target="_blank"
                rel="noreferrer"
                className="transition-colors duration-200 hover:text-accent"
              >
                {shortHex(shown.entry.writer)}
              </a>
            </p>
          )}
        </div>
      </div>

      {/* One line above the rule rather than inside it: anywhere inside, it
          falls on the marks over a statement or on the thumb's own target. */}
      <p className="mt-12 truncate text-center font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">
        drag the rule, or use arrow keys<span className="hidden sm:inline">, one day a step</span>
      </p>

      {/* The rule itself. The whole life of the passport, left to right. */}
      <div className="relative mt-4 h-24 select-none">
        <div aria-hidden className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-line" />

        {segments.map((segment, at) => {
          const left = fractionOf(segment.from, registeredAt, now);
          const right = fractionOf(segment.to, registeredAt, now);
          const lit = at === live;
          const segmentTone = SUMMARY_TONES[segment.summary];
          return (
            <div
              key={`${segment.from}-${at}`}
              aria-hidden
              className={`absolute top-1/2 -translate-y-1/2 transition-all duration-300 ${
                segment.entry === null
                  ? `border-t border-dashed ${lit ? "border-line-strong opacity-100" : "border-line opacity-80"}`
                  : `${segmentTone.fill} ${lit ? "h-[9px] opacity-100" : "h-[3px] opacity-45"}`
              }`}
              style={{
                left: `${left * 100}%`,
                width: `${Math.max(0.6, (right - left) * 100)}%`,
              }}
            />
          );
        })}

        {entries.map((entry) => (
          <span
            key={entry.at}
            aria-hidden
            className="absolute top-1/2 -translate-x-1/2 -translate-y-[calc(50%+1.6rem)]"
            style={{ left: `${fractionOf(entry.at, registeredAt, now) * 100}%` }}
          >
            <UseBlock
              consent={entry.consent}
              size="h-1.5 w-1.5"
              className={`gap-[2px] ${SUMMARY_TONES[plainStatement(entry.consent)].ink}`}
            />
          </span>
        ))}

        {/* The thumb is drawn rather than left to the browser, so it can be a
            hairline to the eye and a 44 px target to a thumb: the input over it
            is transparent and as tall as a finger. */}
        <input
          type="range"
          min={0}
          max={lastDay}
          step={1}
          value={day}
          onChange={(event) => setDay(Number(event.target.value))}
          aria-label="The day to ask the chain about"
          aria-valuetext={dayText(asked)}
          className="peer absolute inset-x-0 top-1/2 h-11 w-full -translate-y-1/2 cursor-ew-resize appearance-none bg-transparent opacity-0"
        />

        <span
          aria-hidden
          className="pointer-events-none absolute top-1/2 h-8 w-[2px] -translate-x-1/2 -translate-y-1/2 bg-accent transition-[left] duration-150 peer-focus-visible:shadow-[0_0_0_3px_var(--accent-soft)]"
          style={{ left: `${fractionOf(asked, registeredAt, now) * 100}%` }}
        />

        <p className="absolute inset-x-0 bottom-0 flex justify-between font-mono text-[10px] uppercase tracking-[0.18em] text-text-faint">
          <span>registered {dayText(registeredAt)}</span>
          <span>today</span>
        </p>

      </div>
    </section>
  );
}
