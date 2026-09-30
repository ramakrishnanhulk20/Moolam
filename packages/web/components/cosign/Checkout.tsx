"use client";

import { motion } from "framer-motion";
import { useTranslations } from "next-intl";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import { CLOSE_AFTER_MS, closeThisWindow, type Closing } from "@/lib/cosign/popup";
import { PRIMARY } from "./Marks";

/**
 * The pieces both checkout windows share: the window itself, laid over the
 * site's own bars so the person sees one focused task, the slim bar that says
 * whose window this is and for whom, the dock that keeps the state and the
 * one button in view, and the line a finished window says as it shuts.
 */

/**
 * The window's frame. It covers the site's header and tab bar and scrolls on
 * its own; data-lenis-prevent hands the wheel back to the browser, since the
 * smooth scroller drives the page underneath, not this.
 */
export const CHECKOUT_SHELL =
  "fixed inset-0 z-50 flex flex-col overflow-y-auto overscroll-contain bg-bg text-text";

/** The inner column: the whole window on a phone, a readable measure anywhere wider. */
export const CHECKOUT_COLUMN = "mx-auto w-full max-w-[34rem] px-5";

/** The dock pinned to the bottom of the window, so the state and the button stay above the fold whatever scrolls. */
export const CHECKOUT_DOCK =
  "sticky bottom-0 z-10 border-t border-line-strong bg-bg/90 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4 backdrop-blur-md";

/** A checkout window's second button: a quiet link, so the one primary stays the only thing that shouts. */
export const QUIET =
  "self-center rounded-[8px] px-3 py-2 text-[11px] uppercase tracking-[0.18em] text-text-muted underline decoration-line-strong underline-offset-4 transition-colors duration-200 hover:text-accent hover:decoration-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Moolam's name at the top of the window, and the lock line naming who asked
 * for it: the platform by name when Moolam lists it, and a plain "a site
 * Moolam does not name" otherwise. The browser's own bar above shows the
 * address, which is what makes the window hard to fake.
 */
export function CheckoutBar({ lock, listed }: { lock: string | null; listed: boolean }) {
  const brand = useTranslations("header");
  return (
    <header className="sticky top-0 z-10 border-b border-line bg-bg/85 backdrop-blur-md">
      <div className={`${CHECKOUT_COLUMN} flex min-h-12 items-center gap-2.5 py-1.5`}>
        <span aria-hidden className="motif h-[18px] w-[18px] shrink-0" />
        <span className="font-display text-[1.05rem] font-semibold tracking-[-0.02em]">{brand("brand")}</span>
        {lock === null ? null : (
          <span
            data-lock-line={listed ? "listed" : "unnamed"}
            className={`ms-auto min-w-0 text-end font-mono text-[10px] uppercase leading-[1.35] tracking-[0.12em] [overflow-wrap:anywhere] ${
              listed ? "text-text" : "text-text-muted"
            }`}
          >
            {/* Inline, so on a narrow phone the lock wraps with its words instead of standing apart from them. */}
            <LockMark className={`me-1.5 inline-block h-3 w-3 align-[-2px] ${listed ? "text-accent" : "text-text-faint"}`} />
            {lock}
          </span>
        )}
      </div>
    </header>
  );
}

function LockMark({ className }: { className: string }) {
  return (
    <svg aria-hidden viewBox="0 0 12 12" className={className} fill="none" stroke="currentColor" strokeWidth="1.3">
      <rect x="2" y="5.25" width="8" height="5.5" rx="1" />
      <path d="M3.9 5.25V3.8a2.1 2.1 0 0 1 4.2 0v1.45" />
    </svg>
  );
}

/**
 * What a finished window says while it shuts: one line naming where the
 * person is going back to, and a hairline that runs out as the window
 * closes. When the browser keeps the window open, the line stays and a
 * button offers the close instead.
 */
export function DoneLine({ closing, platform }: { closing: Exclude<Closing, "idle">; platform: string | null }) {
  const t = useTranslations("checkout");
  const reduced = useIsReducedMotion();
  return (
    <div data-closing={closing} aria-live="polite">
      <p className="font-display text-[1.4rem] font-semibold leading-[1.08] tracking-[-0.025em]">
        {platform === null ? t("doneUnlisted") : t("doneListed", { platform })}
      </p>
      {closing === "closing" ? (
        <span aria-hidden className="mt-4 block h-[2px] overflow-hidden bg-line">
          <motion.span
            className="block h-full origin-left bg-accent"
            initial={{ scaleX: reduced ? 1 : 0 }}
            animate={{ scaleX: 1 }}
            transition={reduced ? { duration: 0 } : { duration: CLOSE_AFTER_MS / 1000, ease: "linear" }}
          />
        </span>
      ) : (
        <button type="button" onClick={closeThisWindow} data-close-window className={`${PRIMARY} mt-4 w-full justify-center`}>
          <span aria-hidden className="motif h-[14px] w-[14px] bg-accent-ink" />
          {t("close")}
        </button>
      )}
    </div>
  );
}
