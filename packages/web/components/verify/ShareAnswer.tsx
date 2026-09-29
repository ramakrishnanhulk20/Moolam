"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

/** How long the button says the link was copied before it offers to copy again. */
const CONFIRM_MS = 2400;

/**
 * The address of a sample's answer on the verify page: opening it runs the same
 * check on the same pinned picture, so the reader it is sent to sees the answer
 * made fresh rather than a stored one.
 */
export function sampleAnswerUrl(location: { origin: string; pathname: string }, id: string): string {
  return `${location.origin}${location.pathname}?sample=${encodeURIComponent(id)}`;
}

const PASSPORT_ID = /^0x[0-9a-fA-F]{64}$/;

/**
 * The passport a shared answer link asks for, from the page's query string, or
 * null when it asks for nothing a check could run on. Anything that is not a
 * passport id is dropped here without a word, so a mangled link opens the page
 * as it always looks.
 */
export function sampleAsked(search: string): string | null {
  const wanted = new URLSearchParams(search).get("sample");
  return wanted !== null && PASSPORT_ID.test(wanted) ? wanted : null;
}

/**
 * Copies the link to a sample's answer and says so on the button itself, where
 * the reader is already looking. A browser that refuses the clipboard gets the
 * shared sentence telling them to copy it by hand, with the address beside it
 * to copy.
 */
export function ShareAnswer({ sampleId }: { sampleId: string }) {
  const t = useTranslations("verify.share");
  const common = useTranslations("common");
  const [state, setState] = useState<"ready" | "copied" | { failed: string }>("ready");

  useEffect(() => {
    if (state !== "copied") {
      return;
    }
    const back = window.setTimeout(() => setState("ready"), CONFIRM_MS);
    return () => window.clearTimeout(back);
  }, [state]);

  async function copy() {
    const url = sampleAnswerUrl(window.location, sampleId);
    try {
      if (navigator.clipboard === undefined) {
        throw new Error("no clipboard");
      }
      await navigator.clipboard.writeText(url);
      setState("copied");
    } catch {
      setState({ failed: url });
    }
  }

  return (
    <div data-share-answer className="min-w-0">
      <button
        type="button"
        onClick={() => void copy()}
        aria-live="polite"
        className={`flex items-center gap-2.5 rounded-[8px] border px-5 py-3.5 text-xs uppercase tracking-[0.16em] transition-colors duration-200 ${
          state === "copied"
            ? "border-verified/60 text-verified"
            : "border-line text-text-muted hover:border-accent hover:text-accent"
        }`}
      >
        <span className={`h-[8px] w-[8px] shrink-0 ${state === "copied" ? "motif" : "border border-current"}`} />
        {state === "copied" ? t("copied") : t("copy")}
      </button>
      {typeof state === "object" ? (
        <div data-share-failed className="mt-3 max-w-[44ch]">
          <p className="text-base leading-relaxed text-failed">{common("copyFailed")}</p>
          <p className="mt-1.5 select-all font-mono text-[11px] text-text-muted [overflow-wrap:anywhere]">{state.failed}</p>
        </div>
      ) : null}
    </div>
  );
}
