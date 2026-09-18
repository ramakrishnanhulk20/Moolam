"use client";

import { motion } from "framer-motion";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { NOTHING_STATED, plainStatement } from "@/lib/chain/consent";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import { UseBlock } from "./Marks";
import { ConsentChip } from "./Summary";
import {
  askConsentAt,
  daysAcross,
  fractionOf,
  secondsForDay,
  segmentAt,
  segmentsOf,
  type LedgerAnswer,
  type LedgerEntry,
} from "./ledger";
import { SUMMARY_TONES } from "./tones";

/**
 * The passport's whole life as one rule, and a thumb that asks the chain what
 * was in force on the day it sits on.
 *
 * This is the question a label in a file cannot answer. A crawler that took a
 * picture in August and a holder who closed their work in September disagree
 * about what was allowed, and only a register that keeps every statement can
 * settle it. So the answer under the thumb is a fresh call to consentAt, and
 * the date it comes back with is the date the chain stands behind.
 *
 * The one part of this card that runs in the browser. Everything under it is
 * the statement that stands today, rendered on the server.
 */
export function ConsentLedger({
  id,
  registeredAt,
  now,
  entries,
  standing,
  className = "",
}: {
  id: string;
  /** When the picture was registered, in whole seconds. The rule starts here. */
  registeredAt: number;
  /** The chain's own clock when this page was rendered, in whole seconds. The rule ends here. */
  now: number;
  entries: LedgerEntry[];
  /** What stands today, read on the server, so the card opens on an answer rather than a wait. */
  standing: LedgerAnswer;
  className?: string;
}) {
  const t = useTranslations("passport.consent");
  const format = useFormatter();
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
      askConsentAt(id, asked, controller.signal)
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
  }, [asked, answer.at, id]);

  const shown = answer.reading;
  const consent = shown.entry?.consent ?? NOTHING_STATED;
  const summary = shown.stated ? plainStatement(consent) : "none";
  const tone = SUMMARY_TONES[summary];
  const live = segmentAt(segments, asked);
  const askedDay = format.dateTime(new Date(answer.at * 1000), { dateStyle: "medium" });

  return (
    <div className={className}>
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:gap-14">
        <div className="min-h-[13rem] min-w-0">
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("onThisDay")}</p>

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
            <p
              data-consent-headline
              className="font-display text-[clamp(1.7rem,4vw,3rem)] font-semibold leading-[0.98] tracking-[-0.03em]"
            >
              {t(`summary.${summary}`)}
            </p>
            <p className="mt-4 flex flex-wrap items-center gap-3">
              <span className="font-mono text-[11px] tracking-[0.14em] text-accent">{askedDay}</span>
              <span aria-hidden className="h-px w-8 bg-line-strong" />
              <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-text-faint">
                {shown.stated && shown.entry !== null
                  ? t("writtenOn", {
                      when: format.dateTime(new Date(shown.entry.at * 1000), {
                        dateStyle: "medium",
                        timeStyle: "short",
                      }),
                    })
                  : t("nothingBy")}
              </span>
            </p>
            <p className="mt-4 max-w-[46ch] text-sm leading-relaxed text-text-muted">{t(`line.${summary}`)}</p>
          </motion.div>

          <p className="mt-5 h-4 font-mono text-[10px] uppercase tracking-[0.2em]">
            {failed !== null ? (
              <span className="text-failed">{t("askFailed")}</span>
            ) : asking ? (
              <span className="text-text-faint">{t("asking")}</span>
            ) : null}
          </p>
        </div>

        <div className="min-h-[13rem] min-w-0 lg:border-s lg:border-line lg:ps-10">
          <UseBlock consent={consent} size="h-7 w-7" className={`gap-[5px] ${tone.ink}`} />
          <ConsentChip summary={summary} className="mt-6" />
        </div>
      </div>

      {/* One line above the rule rather than inside it: anywhere inside, it
          falls on the marks over a statement or on the thumb's own target. */}
      <p className="mt-12 truncate text-center font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">
        {t("scrub")}
        <span className="hidden sm:inline">{t("scrubStep")}</span>
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
          aria-label={t("dayLabel")}
          aria-valuetext={askedDay}
          className="peer absolute inset-x-0 top-1/2 h-11 w-full -translate-y-1/2 cursor-ew-resize appearance-none bg-transparent opacity-0"
        />

        <span
          aria-hidden
          className="pointer-events-none absolute top-1/2 h-8 w-[2px] -translate-x-1/2 -translate-y-1/2 bg-accent transition-[left] duration-150 peer-focus-visible:shadow-[0_0_0_3px_var(--accent-soft)]"
          style={{ left: `${fractionOf(asked, registeredAt, now) * 100}%` }}
        />

        <p className="absolute inset-x-0 bottom-0 flex justify-between gap-4 font-mono text-[10px] uppercase tracking-[0.18em] text-text-faint">
          <span className="truncate">
            {t("registeredOn", { when: format.dateTime(new Date(registeredAt * 1000), { dateStyle: "medium" }) })}
          </span>
          <span className="shrink-0">{t("today")}</span>
        </p>
      </div>
    </div>
  );
}
