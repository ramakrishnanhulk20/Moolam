"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { Link } from "@/lib/i18n/routing";

/** How long after a press on Try again a failure still counts as that try failing. */
const RETRY_WINDOW_MS = 30_000;

/**
 * The last press on Try again. It lives outside the component because a try
 * that fails again does not update this page: React throws it away with the
 * page it tried and draws a fresh one, so anything kept in its state is gone.
 */
let lastTry: { path: string; at: number } | null = null;

export function noteTry(path: string, at: number): void {
  lastTry = { path, at };
}

/** Whether this page is here because a press on Try again, on this address, just failed. */
export function failedAfterTry(path: string, at: number): boolean {
  return lastTry !== null && lastTry.path === path && at - lastTry.at >= 0 && at - lastTry.at < RETRY_WINDOW_MS;
}

function here(): string {
  return typeof window === "undefined" ? "" : window.location.pathname;
}

/**
 * The page a render that failed lands on: a chain read that threw where the
 * page had no answer for it, a component that broke under a reader it did not
 * expect.
 *
 * It is the shape of the not-found page on purpose, because a visitor who hits
 * either one wants the same three things: what happened, one plain way to try
 * the same page again, and the ways on. The error's own message and stack are
 * never printed: they name internals, and on this app an endpoint can itself be
 * a credential.
 *
 * Try again asks the server for the page again as well as drawing it again,
 * because most of what breaks here is a read the server made. It says it is
 * trying while it does, and if the page fails a second time it says so under
 * the button, rather than leaving a screen identical to the one pressed.
 */
export default function LocaleError({
  reset,
  retry,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  retry?: () => void;
}) {
  const t = useTranslations("error");
  const back = useTranslations("notFound");
  const trying = useTranslations("retry");
  const [pending, startTrying] = useTransition();
  // Read once, on the first draw: the answer is about how this page came to be.
  const [again] = useState(() => failedAfterTry(here(), Date.now()));

  const tryAgain = () => {
    noteTry(here(), Date.now());
    startTrying(() => {
      (retry ?? reset)();
    });
  };

  return (
    <div className="relative mx-auto flex min-h-[70vh] w-full max-w-[1400px] flex-col justify-center px-5 py-24 sm:px-8">
      <span aria-hidden className="motif rise h-12 w-12 sm:h-16 sm:w-16" />

      <p
        className="rise mt-10 font-mono text-[11px] uppercase tracking-[0.28em] text-text-faint"
        style={{ animationDelay: "60ms" }}
      >
        {t("code")}
      </p>

      <h1
        className="rise mt-5 max-w-[14ch] font-display text-[clamp(2.6rem,9vw,6.5rem)] font-semibold uppercase leading-[0.88] tracking-[-0.035em]"
        style={{ animationDelay: "110ms" }}
      >
        {t("title")}
      </h1>

      <p
        className="rise mt-8 max-w-[46ch] text-base leading-relaxed text-text-muted sm:text-lg"
        style={{ animationDelay: "170ms" }}
      >
        {t("lede")}
      </p>

      <nav className="rise mt-12 flex flex-wrap items-center gap-3" style={{ animationDelay: "230ms" }}>
        <button
          type="button"
          onClick={tryAgain}
          disabled={pending}
          aria-busy={pending}
          className="inline-flex min-h-11 items-center gap-2.5 rounded-[8px] bg-accent px-5 py-3 text-xs font-semibold uppercase tracking-[0.16em] text-accent-ink transition-[transform,opacity] duration-200 hover:-translate-y-0.5 disabled:cursor-progress disabled:opacity-80 disabled:hover:translate-y-0"
        >
          {pending ? (
            <span aria-hidden className="h-1.5 w-1.5 animate-pulse bg-accent-ink motion-reduce:animate-none" />
          ) : null}
          {pending ? trying("trying") : t("retry")}
        </button>
        {[
          { href: "/explore", label: back("explore") },
          { href: "/verify", label: back("verify") },
          { href: "/docs", label: back("docs") },
        ].map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="inline-flex min-h-11 items-center rounded-[8px] border border-line-strong px-5 py-3 font-mono text-[11px] uppercase tracking-[0.18em] text-text transition-colors duration-200 hover:border-accent hover:text-accent"
          >
            {link.label}
          </Link>
        ))}
      </nav>

      {/* Filled only when the page is back here after a try, and kept in the
          page from the start so a screen reader hears it when it is. */}
      <p role="status" className="mt-4 min-h-[1lh] max-w-[46ch] text-sm leading-relaxed text-failed">
        {again ? (
          <span data-tried-again className="rise flex items-start gap-2.5">
            <span aria-hidden className="mt-[0.45em] h-1.5 w-1.5 shrink-0 bg-failed" />
            {trying("stopped")}
          </span>
        ) : null}
      </p>
    </div>
  );
}
