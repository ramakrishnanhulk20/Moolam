"use client";

import { motion } from "framer-motion";

/**
 * The answer for a picture this browser did not weave, or one that has been cleared. It never says
 * which of the two, so a stranger holding an id learns nothing about it.
 */
export function NotHere() {
  return (
    <motion.section
      initial="hidden"
      animate="shown"
      transition={{ staggerChildren: 0.1 }}
      className="relative mx-auto grid max-w-[88rem] gap-10 px-5 pt-10 pb-24 sm:px-10 sm:pt-16 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] lg:items-center"
    >
      <div>
        <motion.p
          variants={{ hidden: { opacity: 0, y: 20 }, shown: { opacity: 1, y: 0 } }}
          className="text-sm font-bold tracking-[0.14em] text-violet uppercase"
        >
          Picture not found
        </motion.p>
        <motion.h1
          variants={{ hidden: { opacity: 0, y: 32 }, shown: { opacity: 1, y: 0 } }}
          transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
          className="mt-4 font-display text-[clamp(2.75rem,8vw,7rem)] leading-[0.9] font-extrabold tracking-[-0.05em] text-ink"
          style={{ fontVariationSettings: '"opsz" 96, "wdth" 86' }}
        >
          This dream <span className="text-daybreak pr-[0.04em]">slipped away.</span>
        </motion.h1>
        <motion.p
          variants={{ hidden: { opacity: 0, y: 20 }, shown: { opacity: 1, y: 0 } }}
          className="mt-6 max-w-[34rem] text-lg text-ink-soft"
        >
          This picture is not yours or no longer here. Pictures stay with the browser that wove them, and the oldest
          are cleared to make room.
        </motion.p>
        <motion.a
          variants={{ hidden: { opacity: 0, y: 20 }, shown: { opacity: 1, y: 0 } }}
          href="/"
          className="bg-daybreak group mt-8 inline-flex h-14 w-full items-center justify-center gap-2 rounded-full px-8 font-display text-lg font-bold text-white shadow-[0_12px_30px_-10px_rgba(255,106,31,0.7)] transition hover:-translate-y-0.5 hover:shadow-[0_18px_40px_-12px_rgba(90,59,255,0.7)] focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-violet sm:w-auto"
        >
          Weave a new one
          <svg
            aria-hidden
            viewBox="0 0 24 24"
            className="size-5 transition-transform duration-200 group-hover:translate-x-1"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </motion.a>
      </div>

      <motion.div
        aria-hidden
        variants={{ hidden: { opacity: 0, scale: 0.9, rotate: 8 }, shown: { opacity: 1, scale: 1, rotate: 4 } }}
        transition={{ type: "spring", stiffness: 90, damping: 15 }}
        className="relative mx-auto hidden w-full max-w-[26rem] lg:block"
      >
        <div className="rounded-[1.75rem] bg-card p-2.5 shadow-[0_40px_80px_-30px_rgba(23,18,43,0.45)] ring-1 ring-ink/5">
          <div className="relative aspect-square overflow-hidden rounded-[1.35rem] border-2 border-dashed border-violet/30 bg-[radial-gradient(120%_90%_at_20%_10%,#e2dcff_0%,#f6f4ff_55%,#ffe9d9_100%)]">
            <div className="dream-cloud absolute top-1/4 left-1/4 size-40 rounded-full bg-violet/25 blur-2xl" />
            <div className="dream-cloud absolute right-1/5 bottom-1/5 size-32 rounded-full bg-tangerine/25 blur-2xl" />
          </div>
        </div>
      </motion.div>
    </motion.section>
  );
}
