"use client";

import { motion } from "framer-motion";
import type { ReactNode } from "react";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import { WarningMark } from "@/components/WarningMark";

export const EASE = [0.16, 1, 0.3, 1] as const;

/** Where a state leaves the person, and so which ink it is drawn in. Only a failure is red. */
export type Tone = "ask" | "wait" | "stop" | "done" | "failed";

const KICKER_INK: Record<Tone, string> = {
  ask: "text-accent",
  wait: "text-text-muted",
  stop: "text-text-muted",
  done: "text-verified",
  failed: "text-failed",
};

/** The small mark in front of a state's kicker: the kolam everywhere but a failure, which gets the stop mark. */
export function ToneMark({ tone, size = 9 }: { tone: Tone; size?: number }) {
  if (tone === "failed") {
    return <WarningMark className="text-failed" />;
  }
  const ink = tone === "done" ? "bg-verified" : tone === "stop" ? "bg-text-muted" : "";
  return (
    <span
      aria-hidden
      className={`motif shrink-0 ${ink} ${tone === "wait" ? "motion-safe:animate-pulse" : ""}`}
      style={{ width: size, height: size }}
    />
  );
}

export function Kicker({ tone, children, className = "" }: { tone: Tone; children: ReactNode; className?: string }) {
  return (
    <p
      className={`flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] ${KICKER_INK[tone]} ${className}`}
    >
      <ToneMark tone={tone} />
      {children}
    </p>
  );
}

/**
 * A state's words, risen in whenever the state changes, so the eye sees the
 * page answer rather than blink. Enter only, with no exit to wait on: a run
 * can pass through several states in a second, and words held back behind an
 * old state's exit would show the wrong state for as long as it lasts.
 */
export function StateSwap({ state, children, className = "" }: { state: string; children: ReactNode; className?: string }) {
  const reduced = useIsReducedMotion();
  return (
    <motion.div
      key={state}
      data-state-words={state}
      initial={reduced ? false : { opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduced ? { duration: 0 } : { duration: 0.35, ease: EASE }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

/** A state's line in its own ink: the failure red for a failure and nothing else. */
export function StateLine({ tone, children, className = "" }: { tone: Tone; children: ReactNode; className?: string }) {
  if (tone === "failed") {
    return (
      <p role="alert" className={`flex items-start gap-2.5 text-base leading-relaxed text-failed ${className}`}>
        <WarningMark className="mt-[5px]" />
        <span className="min-w-0">{children}</span>
      </p>
    );
  }
  return <p className={`text-base leading-relaxed text-text-muted ${className}`}>{children}</p>;
}

export const PRIMARY =
  "inline-flex items-center gap-3 rounded-[8px] bg-accent px-7 py-4 text-sm font-semibold uppercase tracking-[0.14em] text-accent-ink transition-[transform,box-shadow,opacity] duration-200 hover:-translate-y-0.5 hover:shadow-[0_16px_34px_-16px_var(--accent)] active:translate-y-0 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 disabled:hover:shadow-none";

export const SECONDARY =
  "inline-flex items-center rounded-[8px] border border-line-strong px-5 py-3.5 text-[11px] uppercase tracking-[0.18em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-line-strong disabled:hover:text-text-muted";

/** An address cut short for a line of text: the first six and last four, the way the site prints addresses. */
export function shortAddress(value: string): string {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/** Chain time as the page prints it: the chain keeps UTC, so the page does too. */
export function chainClock(seconds: number): string {
  const at = new Date(seconds * 1000);
  const hours = String(at.getUTCHours()).padStart(2, "0");
  const minutes = String(at.getUTCMinutes()).padStart(2, "0");
  return `${hours}:${minutes} UTC`;
}
