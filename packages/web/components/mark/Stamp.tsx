"use client";

import { motion } from "framer-motion";
import { WarningMark } from "@/components/WarningMark";
import { TONE_EDGE, TONE_INK, type MarkTone } from "./tones";
import type { MarkState } from "./mark";

const EASE = [0.16, 1, 0.3, 1] as const;

/**
 * The trust mark as a rubber stamp: its word in a double rule, pressed onto the
 * page once when it arrives. The press is a scale and a settle, which the
 * page's MotionScope cuts to a plain fade for a reader who asked for less
 * motion. The small size sits beside the kolam on the poster; the large one
 * leads the band under it.
 */
export function MarkStamp({
  state,
  word,
  tone,
  size = "sm",
  delay = 0,
}: {
  state: MarkState | "unread";
  word: string;
  tone: MarkTone;
  size?: "sm" | "lg";
  /** Seconds before the press, so it lands after the title has risen. */
  delay?: number;
}) {
  const large = size === "lg";
  return (
    <motion.span
      data-mark-stamp={state}
      initial={{ opacity: 0, scale: 1.35, rotate: large ? -7 : -5 }}
      animate={{ opacity: 1, scale: 1, rotate: large ? -2 : 0 }}
      transition={{ duration: 0.55, delay, ease: EASE }}
      className={`inline-flex max-w-full origin-center items-center rounded-[6px] font-mono font-bold uppercase leading-none ${TONE_INK[tone]} ${TONE_EDGE[tone]} ${
        large
          ? "gap-3 border-[2.5px] px-3.5 py-2.5 text-[clamp(0.95rem,2.2vw,1.35rem)] tracking-[0.1em] shadow-[inset_0_0_0_3px_var(--bg),inset_0_0_0_4px_currentColor]"
          : "gap-2 border-[1.5px] px-2 py-1 text-[10px] tracking-[0.16em]"
      } bg-bg/85 backdrop-blur-sm`}
    >
      <Glyph state={state} large={large} />
      <span className="min-w-0 break-words">{word}</span>
    </motion.span>
  );
}

/** One small shape per mark, so the mark reads at a glance before its word does. */
function Glyph({ state, large }: { state: MarkState | "unread"; large: boolean }) {
  const box = large ? "h-[1.05em] w-[1.05em]" : "h-[9px] w-[9px]";
  if (state === "mismatch" || state === "upheld") {
    return <WarningMark className={large ? "h-[1.05em] w-[1.05em]" : "h-[10px] w-[10px]"} />;
  }
  if (state === "lookalike") {
    return (
      <svg aria-hidden viewBox="0 0 28 22" className={large ? "h-[1em] w-[1.3em] shrink-0" : "h-[9px] w-[12px] shrink-0"}>
        <rect x="1.5" y="1.5" width="16" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" />
        <rect x="9" y="8" width="17" height="12.5" fill="currentColor" />
      </svg>
    );
  }
  if (state === "waiting") {
    return (
      <span aria-hidden className={`${box} shrink-0 rounded-full border-2 border-dotted border-current motion-safe:animate-pulse`} />
    );
  }
  if (state === "checked") {
    return <span aria-hidden className={`motif ${box} shrink-0 bg-current`} />;
  }
  if (state === "challenged") {
    return <span aria-hidden className={`${box} shrink-0 rotate-45 border-2 border-current`} />;
  }
  return <span aria-hidden className={`${box} shrink-0 border border-current opacity-70`} />;
}
