"use client";

import { motion } from "framer-motion";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { NOTHING_STATED, plainStatement } from "@/lib/chain/consent";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import { UseBlock, UseLegend } from "./Marks";
import { ConsentChip } from "./Summary";
import {
  askConsentAt,
  askedMinute,
  daysAcross,
  fractionOf,
  secondsForDay,
  segmentAt,
  segmentsOf,
  type LedgerAnswer,
  type LedgerEntry,
} from "./ledger";
import { SUMMARY_TONES } from "./tones";
import { WarningMark } from "@/components/WarningMark";

/**
 * The range input is the real control, so it keeps the site's focus ring. Only
 * its own thumb and track are made invisible, because the rule and the thumb
 * are drawn by hand underneath it. Hiding the whole input with opacity hid the
 * ring with it.
 */
export const HIDDEN_THUMB = [
  "[&::-webkit-slider-runnable-track]:bg-transparent",
  "[&::-webkit-slider-thumb]:h-11 [&::-webkit-slider-thumb]:w-6 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:opacity-0",
  "[&::-moz-range-track]:bg-transparent [&::-moz-range-progress]:bg-transparent",
  "[&::-moz-range-thumb]:h-11 [&::-moz-range-thumb]:w-6 [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:opacity-0",
].join(" ");

/** How long one reading of the browser's clock is kept still, in seconds. */
const CLOCK_HELD = 60;

let arrived = 0;

/**
 * The reader's own clock in whole seconds, held still between readings.
 *
 * A snapshot that answered a new number every time React asked would put React
 * in a loop, so the reading moves a minute at a time. That is close enough for
 * a rule whose smallest notch is a day, and it lets a tab left open overnight
 * catch up on its next render rather than staying on yesterday.
 */
function readClock(): number {
  const seconds = Math.floor(Date.now() / 1000);
  if (seconds - arrived >= CLOCK_HELD) {
    arrived = seconds;
  }
  return arrived;
}

/** Nothing pushes the time at this card. A reload, or any later render, is enough. */
const noWatch = () => () => undefined;

/**
 * How far past the render a reader's own clock may carry the end of the rule.
 *
 * The route answers for a day either side of its own now, so a device running
 * a day fast would ask about a moment it refuses and the card would meet an
 * error on the first drag. Just under a day is as far as the rule can honestly
 * reach anyway: the page's own clock came from the chain.
 */
const CLOCK_REACH = 23 * 60 * 60;

/**
 * When this reader arrived, with the server's own clock standing in until there
 * is a browser to ask.
 *
 * The passport page is built ahead of its first visitor and then held for a
 * minute, so the moment it was rendered can be yesterday by the time anybody
 * reads it. Read through the store hook rather than set from an effect, so
 * React hydrates the markup it was given and swaps to the real answer on the
 * render straight after, with no mismatch to throw the card away over.
 */
function useArrival(rendered: number): number {
  return useSyncExternalStore(noWatch, readClock, () => rendered);
}

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
  now: rendered,
  entries,
  standing,
  className = "",
}: {
  id: string;
  /** When the picture was registered, in whole seconds. The rule starts here. */
  registeredAt: number;
  /** The chain's own clock when this page was rendered, in whole seconds. The first paint ends here. */
  now: number;
  entries: LedgerEntry[];
  /** What stands today, read on the server, so the card opens on an answer rather than a wait. */
  standing: LedgerAnswer;
  className?: string;
}) {
  const t = useTranslations("passport.consent");
  const format = useFormatter();
  const reduced = useIsReducedMotion();

  // A reader's clock is never let to pull the end of the rule backwards: a
  // browser running a day slow would otherwise hide a statement the register
  // has already taken. Nor may it run away with it: a clock a day fast would
  // push the rule's end past the window the route will answer for.
  const arrival = useArrival(rendered);
  const now = Math.min(Math.max(rendered, arrival), rendered + CLOCK_REACH);

  const lastDay = daysAcross(registeredAt, now);
  const segments = useMemo(() => segmentsOf(registeredAt, now, entries), [registeredAt, now, entries]);

  // Null until the thumb is moved: it rides the end of the rule, so a day that
  // arrives after the page was built carries it along with it.
  const [day, setDay] = useState<number | null>(null);
  const [answer, setAnswer] = useState<{ at: number; reading: LedgerAnswer } | null>(null);
  const [asking, setAsking] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const onDay = day ?? lastDay;
  // Asked on the whole minute, so every reader of this passport on this day
  // asks the same URL and the answer in front of the route is shared.
  const asked = askedMinute(secondsForDay(onDay, registeredAt, now));

  useEffect(() => {
    // The end of the rule is the moment the server already answered for. Asking
    // again on arrival would cost every reader a call for the statement they
    // were handed the page with.
    if (day === null || asked === answer?.at) {
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
  }, [day, asked, answer?.at, id]);

  const shown = answer?.reading ?? standing;
  const shownAt = answer?.at ?? now;
  const consent = shown.entry?.consent ?? NOTHING_STATED;
  const summary = shown.stated ? plainStatement(consent) : "none";
  const tone = SUMMARY_TONES[summary];
  const live = segmentAt(segments, asked);
  const askedDay = format.dateTime(new Date(shownAt * 1000), { dateStyle: "medium" });
  // The day under the thumb, which a screen reader hears as it moves, before
  // the chain has answered for it.
  const thumbDay = format.dateTime(new Date(asked * 1000), { dateStyle: "medium" });

  return (
    <div className={className}>
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:gap-14">
        <div className="min-h-[13rem] min-w-0">
          {/* A caption, not the opening of a sentence: the big line under it is
              the statement itself, and "Not for AI training" completes nothing. */}
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">
            {onDay === lastDay ? t("inForceToday") : t("onThisDay")}
          </p>

          {/* Keyed on the moment asked, so a new answer settles in rather than
              swapping in place. The statement the page was rendered with keeps
              one key across the reader's clock arriving, so the card does not
              replay its entrance a tick after it mounts. The height above and
              below is reserved, so nothing on the page moves while the chain is
              being asked. */}
          <motion.div
            key={answer === null ? "standing" : answer.at}
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
                      when: format.dateTime(new Date(shown.entry.at * 1000), "moment"),
                    })
                  : t("nothingBy")}
              </span>
            </p>
            <p className="mt-4 max-w-[46ch] text-sm leading-relaxed text-text-muted">{t(`line.${summary}`)}</p>
          </motion.div>

          <DayAnswerLine state={failed !== null ? "failed" : asking ? "asking" : null} />
        </div>

        {/* The four marks land with the answer they belong to rather than
            changing under a headline that is still settling. Only the ink and
            the shapes move: the names hold the box at one height. */}
        <motion.div
          key={answer === null ? "standing-marks" : `${answer.at}-marks`}
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 14 }}
          animate={{ opacity: asking ? 0.45 : 1, y: 0 }}
          transition={reduced ? { duration: 0.15 } : { duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          className="min-h-[13rem] min-w-0 lg:border-s lg:border-line lg:ps-10"
        >
          <UseLegend consent={consent} className={tone.ink} />
          <ConsentChip summary={summary} className="mt-7" />
        </motion.div>
      </div>

      {/* One line above the rule rather than inside it: anywhere inside, it
          falls on the marks over a statement or on the thumb's own target. */}
      {/* A thumb has no arrow keys, so a coarse pointer is told to drag and
          nothing else. The swap is a media query rather than a guess at the
          device, because the same page can be opened either way, and it asks
          about the pointer alone: a mouse in a narrow window is still a mouse
          with arrow keys beside it, and it used to be told half the sentence.
          Exactly one of the two is ever displayed. */}
      <p className="mt-12 truncate text-center font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">
        <span className="pointer-fine:hidden">{t("scrubTouch")}</span>
        <span className="hidden pointer-fine:inline">
          {t("scrub")}
          {t("scrubStep")}
        </span>
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
          value={onDay}
          onChange={(event) => setDay(Number(event.target.value))}
          aria-label={t("dayLabel")}
          aria-valuetext={thumbDay}
          className={`peer absolute inset-x-0 top-1/2 h-11 w-full -translate-y-1/2 cursor-ew-resize appearance-none bg-transparent ${HIDDEN_THUMB}`}
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

/**
 * The line under the statement while a day is asked, and when it could not be.
 *
 * The wait is one mono word and keeps the row's height. The failure is two
 * sentences with a next step in it, so it is set in the reading face at a size
 * that can be read and the row grows to hold it in every language, rather
 * than spilling out of a row cut for one word.
 */
export function DayAnswerLine({ state }: { state: "failed" | "asking" | null }) {
  const t = useTranslations("passport.consent");

  return (
    <div className="mt-5 min-h-4">
      {state === "failed" ? (
        <p
          role="alert"
          data-day-failed
          className="flex max-w-[46ch] items-start gap-2.5 text-sm leading-relaxed text-failed"
        >
          <WarningMark className="mt-[3px]" />
          {t("askFailed")}
        </p>
      ) : state === "asking" ? (
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("asking")}</p>
      ) : null}
    </div>
  );
}
