"use client";

import { motion } from "framer-motion";
import { useId } from "react";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";

/**
 * The seal pressed onto a registered picture: the kolam knot in the middle and
 * the passport's id running round the ring, the way a rubber stamp carries its
 * office's name. It lands with a short overshoot, like a stamp meeting paper,
 * and simply appears for a reader who asked for less motion.
 */
export function SealStamp({ label, ring, className = "" }: { label: string; ring: string; className?: string }) {
  const reduced = useIsReducedMotion();
  const path = useId().replace(/:/g, "");

  return (
    <motion.span
      data-seal-stamp
      aria-label={label}
      role="img"
      initial={reduced ? false : { opacity: 0, scale: 1.7, rotate: -24 }}
      animate={{ opacity: 1, scale: 1, rotate: -9 }}
      transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 320, damping: 17 }}
      className={`pointer-events-none block text-verified ${className}`}
    >
      <svg viewBox="0 0 200 200" className="absolute inset-0 h-full w-full" aria-hidden>
        <defs>
          <path id={path} d="M100,100 m-74,0 a74,74 0 1,1 148,0 a74,74 0 1,1 -148,0" />
        </defs>
        {/* A wash of the page's ground under the ink, so the id reads over any picture. */}
        <circle cx="100" cy="100" r="96" fill="var(--bg)" fillOpacity="0.62" />
        <circle cx="100" cy="100" r="96" fill="none" stroke="currentColor" strokeWidth="3" />
        <circle cx="100" cy="100" r="58" fill="none" stroke="currentColor" strokeWidth="1.2" />
        <text
          fill="currentColor"
          style={{ fontFamily: "var(--font-mono), ui-monospace, monospace", fontSize: 13.5, letterSpacing: "0.12em" }}
        >
          <textPath href={`#${path}`} textLength="462">
            {ring}
          </textPath>
        </text>
      </svg>
      {/* The knot's own rule pins it to position relative, so a wrapper places it. */}
      <span aria-hidden className="absolute left-1/2 top-1/2 flex h-[38%] w-[38%] -translate-x-1/2 -translate-y-1/2">
        <span className="motif h-full w-full bg-verified" />
      </span>
    </motion.span>
  );
}

/**
 * The seal before it is pressed: a dashed ring and a faint knot over the
 * print's corner, so the page shows from the first second where the passport
 * will land. It hovers while the passkey is out, and dims where nothing will
 * be pressed.
 */
export function GhostSeal({ pressing, idle }: { pressing: boolean; idle: boolean }) {
  const reduced = useIsReducedMotion();
  return (
    <motion.span
      aria-hidden
      data-ghost-seal
      className={`absolute inset-0 block text-accent ${idle ? "opacity-25" : "opacity-70"}`}
      animate={pressing && !reduced ? { scale: [1.18, 1.08, 1.18], y: [-10, -4, -10] } : { scale: 1, y: 0 }}
      transition={pressing && !reduced ? { duration: 1.4, repeat: Infinity, ease: "easeInOut" } : { duration: 0.3 }}
    >
      <svg viewBox="0 0 200 200" className="absolute inset-0 h-full w-full">
        <circle cx="100" cy="100" r="96" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="6 7" />
        <circle cx="100" cy="100" r="58" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="3 6" />
      </svg>
      <span className="absolute left-1/2 top-1/2 flex h-[38%] w-[38%] -translate-x-1/2 -translate-y-1/2 opacity-60">
        <span className="motif h-full w-full" />
      </span>
    </motion.span>
  );
}

/** A fixed scatter, so the faded field lands in the same places on every load. */
function scatter(count: number): { left: number; top: number; size: number; depth: number; turn: number }[] {
  let state = 0x9e3779b9;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
  return Array.from({ length: count }, () => {
    const depth = next();
    return {
      left: next() * 96 - 4,
      top: next() * 96 - 4,
      size: 7 + depth * 9,
      depth,
      turn: (next() - 0.5) * 10,
    };
  });
}

export const FIELD = scatter(18);
