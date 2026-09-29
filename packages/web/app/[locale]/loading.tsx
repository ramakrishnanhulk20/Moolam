"use client";

import { motion } from "framer-motion";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { switchOnItsWay } from "@/components/LocaleSwitch";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";

/**
 * The first screen each kind of page opens with, so the wait takes the shape of
 * the page on its way and nothing jumps when it lands. "poster" and "agent" are
 * the tall headers a passport and an agent open under; "explore" is the sheet,
 * whose top padding differs between a tablet and a laptop; "page" is the rest.
 */
export type OpeningFrame = "page" | "explore" | "poster" | "agent";

const POSTER_HEIGHT: Partial<Record<OpeningFrame, string>> = {
  poster: "h-[74svh] min-h-[34rem] sm:h-[min(78vh,46rem)]",
  agent: "min-h-[30rem] sm:min-h-[38rem]",
};

const SHEET_PAD: Partial<Record<OpeningFrame, string>> = {
  page: "pt-7 sm:pt-9",
  explore: "pt-7 sm:pt-24 lg:pt-9",
};

/** How long the mark waits after a press, in seconds, so a page already fetched never flashes it. */
const BEAT = 0.14;

/**
 * How long it waits when it stands in for a language switch. The old page was
 * dimmed in place while the new language was fetched, and a switch that lands
 * inside this reads as one change rather than a loading line flashed between
 * two pages. On the dev server the page came 0.4 s after its frame.
 */
const SWITCH_BEAT = 0.7;

/** How the mark comes in: after a beat, or after a longer one for a language switch, and without motion when less is asked for. */
export function openingEntrance(
  switching: boolean,
  reduced: boolean,
): {
  initial: false | { opacity: number; y?: number };
  transition: { delay: number; duration: number; ease?: [number, number, number, number] };
} {
  const delay = switching ? SWITCH_BEAT : BEAT;
  if (reduced) {
    // Still no movement, but a switch still waits before the words appear.
    return switching ? { initial: { opacity: 0 }, transition: { delay, duration: 0 } } : { initial: false, transition: { delay: 0, duration: 0 } };
  }
  return { initial: { opacity: 0, y: 8 }, transition: { delay, duration: 0.5, ease: [0.16, 1, 0.3, 1] } };
}

/**
 * What a press shows while the page it opened is still being read.
 *
 * Every page under a language renders inside the frame, so the header, the tab
 * bar and the footer stay put and only this part stands in for the page. Before
 * it, pressing Make, My pictures or a passport changed nothing on the screen
 * until the whole new page arrived, a second or more on a phone, and a reader
 * pressed again.
 *
 * It fades in after a beat, so a page that is already fetched never flashes it.
 * Under reduced motion it is simply there, the seal still and the rule empty.
 */
export default function Opening({ frame = "page" }: { frame?: OpeningFrame }) {
  const common = useTranslations("common");
  const reduced = useIsReducedMotion();
  const poster = POSTER_HEIGHT[frame];
  // Read once, as this screen mounts, which is in the same moment the new
  // language's frame does.
  const [switching] = useState(() => typeof window !== "undefined" && switchOnItsWay());
  const entrance = openingEntrance(switching, reduced);

  const mark = (
    <motion.div
      initial={entrance.initial}
      animate={{ opacity: 1, y: 0 }}
      transition={entrance.transition}
      className="flex flex-col items-start"
    >
      <p
        role="status"
        className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.28em] text-text-faint"
      >
        <span aria-hidden className="motif h-3 w-3 shrink-0 animate-pulse motion-reduce:animate-none" />
        {common("openingPage")}
      </p>
      {/* A film leader's rule: one short run of the accent crossing a hairline,
          the only thing on the screen that moves. */}
      <span aria-hidden className="relative mt-5 block h-px w-[min(22rem,70vw)] overflow-hidden bg-line">
        {reduced ? null : (
          <motion.span
            className="absolute inset-y-0 start-0 block w-1/3 bg-accent"
            initial={{ x: "-100%" }}
            animate={{ x: "300%" }}
            transition={{ duration: 1.6, ease: [0.65, 0, 0.35, 1], repeat: Infinity, repeatDelay: 0.2 }}
          />
        )}
      </span>
    </motion.div>
  );

  if (poster !== undefined) {
    return (
      <div data-opening={frame} aria-busy className="min-h-[70vh]">
        <div className={`grain relative w-full overflow-hidden border-b border-line bg-bg-sunken ${poster}`}>
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-gradient-to-t from-bg/80 via-transparent to-transparent"
          />
          <div className="absolute inset-x-0 bottom-0">
            <div className="mx-auto w-full max-w-[1400px] px-5 pb-12 sm:px-8 sm:pb-16">{mark}</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      data-opening={frame}
      aria-busy
      className={`mx-auto min-h-[70vh] w-full max-w-[1400px] px-5 pb-16 sm:px-8 sm:pb-24 ${SHEET_PAD[frame] ?? SHEET_PAD.page}`}
    >
      {mark}
    </div>
  );
}
