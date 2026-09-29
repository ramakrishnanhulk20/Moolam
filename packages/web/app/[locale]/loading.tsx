"use client";

import { motion } from "framer-motion";
import { useTranslations } from "next-intl";
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

  const mark = (
    <motion.div
      initial={reduced ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.14, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
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
