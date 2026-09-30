"use client";

import { useEffect, useState, type ReactNode } from "react";

export const PRIMARY_BUTTON =
  "bg-daybreak group inline-flex min-h-14 w-full cursor-pointer items-center justify-center gap-2 rounded-full px-5 py-3 text-center font-display text-[1.05rem] leading-tight font-bold text-balance sm:px-7 sm:text-lg text-white shadow-[0_12px_30px_-10px_rgba(255,106,31,0.7)] transition-[transform,box-shadow,opacity] duration-200 hover:-translate-y-0.5 hover:shadow-[0_18px_40px_-12px_rgba(90,59,255,0.7)] focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-violet active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0";

export const INK_BUTTON =
  "group inline-flex min-h-14 w-full cursor-pointer items-center justify-center gap-2 rounded-full bg-ink px-5 py-3 text-center font-display text-[1.05rem] leading-tight font-bold text-balance text-white sm:px-7 sm:text-lg shadow-[0_12px_30px_-14px_rgba(23,18,43,0.6)] transition duration-200 hover:-translate-y-0.5 hover:bg-violet-deep focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-violet active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0 disabled:hover:bg-ink";

export const QUIET_BUTTON =
  "inline-flex min-h-12 cursor-pointer items-center justify-center gap-2 rounded-full border-2 border-ink/10 bg-card px-5 py-2.5 text-base font-semibold text-ink transition duration-200 hover:-translate-y-0.5 hover:border-violet hover:text-violet focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-violet disabled:cursor-not-allowed disabled:opacity-60";

/** Seconds since a moment, ticking once a second, so every long wait on this page shows it is alive. */
export function useSecondsSince(since: number | null): number {
  const [now, setNow] = useState(() => since ?? 0);
  useEffect(() => {
    if (since === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [since]);
  return since === null ? 0 : Math.max(0, Math.floor((now - since) / 1000));
}

export function ProblemNote({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-2xl border-2 border-alert/20 bg-alert/5 px-4 py-3 text-base font-medium text-alert">
      {children}
    </p>
  );
}

export function Arrow({ className = "size-5" }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className={`${className} shrink-0 transition-transform duration-200 group-hover:translate-x-1`}
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

export function OutArrow({ className = "size-4" }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className={`${className} shrink-0 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5`}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 11l6-6M6 5h5v5" />
    </svg>
  );
}

export function Spinner() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="size-5 shrink-0 animate-spin motion-reduce:animate-none" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.35" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/** A dot that breathes while something is on its way, and holds still for a visitor who asked for less motion. */
export function LiveDot() {
  return (
    <span aria-hidden className="relative inline-flex size-3 shrink-0">
      <span className="absolute inset-0 animate-ping rounded-full bg-tangerine/60 motion-reduce:animate-none" />
      <span className="relative inline-flex size-3 rounded-full bg-tangerine" />
    </span>
  );
}
