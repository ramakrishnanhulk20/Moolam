"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useId, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { LiveDot, OutArrow, PRIMARY_BUTTON, QUIET_BUTTON } from "./bits";
import { CHECKOUT_NAME, checkout } from "./window-flow";

export type CheckoutPlace = "sign" | "share";

const LINES: Record<CheckoutPlace, { waiting: string; line: string; open: string }> = {
  sign: {
    waiting: "Waiting for your signature",
    line: "Sign in on Moolam, check the picture and its terms, then sign with your passkey. This page moves on by itself when you are done.",
    open: "Open Moolam's co-sign page",
  },
  share: {
    waiting: "Waiting for your address",
    line: "Share your Moolam address with Dreamloom in that window. You check the address here before anything moves.",
    open: "Open Moolam's connect page",
  },
};

/**
 * The card this page shows while Moolam's window is open, over the dimmed page, like a checkout.
 * When the browser refused the window, the link itself is the button; it still keeps its opener,
 * so Moolam's page can answer here.
 */
export function CheckoutCardView({
  place,
  link,
  blocked,
  onReopen,
  onCancel,
}: {
  place: CheckoutPlace;
  link: string;
  blocked: boolean;
  onReopen: () => void;
  onCancel: () => void;
}) {
  const words = LINES[place];
  const titleId = useId();
  const lineId = useId();

  // A press on the fallback link tries the sized window first; only when that is refused too does
  // the link open Moolam the ordinary way.
  const openFromLink = (event: MouseEvent<HTMLAnchorElement>) => {
    if (checkout.reopen(link) !== "blocked") event.preventDefault();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={lineId}
      className="relative w-full max-w-[29rem] overflow-hidden rounded-t-[2rem] bg-card p-6 pb-8 shadow-[0_40px_90px_-30px_rgba(23,18,43,0.7)] ring-1 ring-ink/10 sm:rounded-[2rem] sm:p-8"
    >
      <div aria-hidden className="bg-daybreak absolute inset-x-0 top-0 h-1.5" />
      <WindowSketch />

      <p className="mt-6 flex items-center gap-2.5 text-sm font-bold tracking-[0.12em] text-violet uppercase">
        <LiveDot />
        {words.waiting}
      </p>
      <h2
        id={titleId}
        className="mt-2 font-display text-[clamp(1.75rem,4vw,2.25rem)] leading-[0.95] font-extrabold tracking-[-0.04em] text-ink"
      >
        Finish in the Moolam window
      </h2>
      <p id={lineId} className="mt-3 text-base text-ink-soft">
        {blocked ? "Your browser stopped the Moolam window from opening. Open it from here instead." : words.line}
      </p>

      <div className="mt-6 flex flex-col gap-3">
        {blocked ? (
          <a href={link} target={CHECKOUT_NAME} rel="opener" onClick={openFromLink} className={PRIMARY_BUTTON}>
            {words.open}
            <OutArrow className="size-5" />
          </a>
        ) : (
          <button type="button" onClick={onReopen} className={PRIMARY_BUTTON}>
            Reopen the window
            <OutArrow className="size-5" />
          </button>
        )}
        <button type="button" onClick={onCancel} className={`${QUIET_BUTTON} w-full`}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** A small Moolam window floating over a dimmed page: the picture of what just happened. */
function WindowSketch() {
  return (
    <div aria-hidden className="relative mx-auto mt-2 h-24 w-40">
      <div className="absolute inset-x-0 bottom-0 h-16 rounded-2xl bg-mist/80 ring-1 ring-ink/5">
        <div className="mx-3 mt-3 h-2 w-16 rounded-full bg-ink/10" />
        <div className="mx-3 mt-2 h-2 w-24 rounded-full bg-ink/10" />
      </div>
      <motion.div
        animate={{ y: [0, -5, 0] }}
        transition={{ duration: 3.2, repeat: Infinity, ease: "easeInOut" }}
        className="absolute top-0 left-1/2 w-20 -translate-x-1/2 overflow-hidden rounded-xl bg-[#14121c] shadow-[0_18px_30px_-12px_rgba(23,18,43,0.7)] ring-1 ring-white/10"
      >
        <div className="flex gap-1 px-2 py-1.5">
          <span className="size-1.5 rounded-full bg-white/30" />
          <span className="size-1.5 rounded-full bg-white/30" />
          <span className="size-1.5 rounded-full bg-white/30" />
        </div>
        <div className="flex h-12 items-center justify-center border-t border-white/10">
          <img src="/moolam-mark.svg" alt="" width={24} height={24} className="size-6" />
        </div>
      </motion.div>
    </div>
  );
}

/**
 * The card over the dimmed page, drawn at the top of the document so no tilted or clipped panel
 * around it can pull it out of place. Escape counts as Cancel.
 */
export function CheckoutOverlay({
  open,
  place,
  link,
  blocked,
  onReopen,
  onCancel,
}: {
  open: boolean;
  place: CheckoutPlace;
  link: string | null;
  blocked: boolean;
  onReopen: () => void;
  onCancel: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  const layer = useRef<HTMLDivElement>(null);
  const shown = open && link !== null;

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!shown) return;
    const before = document.activeElement as HTMLElement | null;
    const first = layer.current?.querySelector<HTMLElement>("a, button");
    first?.focus({ preventScroll: true });
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("keydown", key);
      before?.focus?.({ preventScroll: true });
    };
  }, [shown, onCancel]);

  if (!mounted) return null;
  return createPortal(
    <AnimatePresence>
      {shown && (
        <motion.div
          key="checkout"
          ref={layer}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25 }}
          className="fixed inset-0 z-50 flex items-end justify-center bg-ink/55 backdrop-blur-[3px] sm:items-center sm:p-6"
        >
          <motion.div
            initial={{ opacity: 0, y: 40, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 24 }}
            transition={{ type: "spring", stiffness: 180, damping: 22 }}
            className="w-full sm:max-w-[29rem]"
          >
            <CheckoutCardView place={place} link={link} blocked={blocked} onReopen={onReopen} onCancel={onCancel} />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
