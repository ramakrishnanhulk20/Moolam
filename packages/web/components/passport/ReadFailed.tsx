"use client";

import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { WarningMark } from "@/components/WarningMark";

/**
 * The passport page when Monad would not hand over the record: what happened,
 * one press to ask again, and a way on to the rest of the registry.
 *
 * The client library's own words are kept for anyone reporting the problem,
 * folded away under Details, because they are English in every language and
 * say nothing a reader can act on.
 *
 * The words and the Explore address arrive from the server page, which knows
 * the language, so this only adds the one thing a server render cannot do: ask
 * again. The address comes whole rather than through the locale-aware Link,
 * which keeps this failure page to the fewest moving parts.
 */
export function ReadFailed({
  sentence,
  retry,
  explore,
  exploreHref,
  details,
  reason,
}: {
  sentence: string;
  retry: string;
  explore: string;
  /** The Explore page in the reader's language, such as /ta/explore. */
  exploreHref: string;
  details: string;
  reason: string;
}) {
  const router = useRouter();
  const [asking, startAsking] = useTransition();

  return (
    <div data-read-failed className="mx-auto flex min-h-[60vh] w-full max-w-[1400px] flex-col justify-center px-5 py-24 sm:px-8">
      <span aria-hidden className="motif rise h-10 w-10 sm:h-12 sm:w-12" />

      <p
        role="alert"
        className="rise mt-10 flex max-w-[30ch] items-start gap-4 font-display text-[clamp(1.6rem,4.2vw,3rem)] font-semibold leading-[1.02] tracking-[-0.03em] text-failed"
        style={{ animationDelay: "60ms" }}
      >
        <WarningMark className="mt-[0.35em] h-[0.6em] w-[0.6em]" />
        {sentence}
      </p>

      <nav className="rise mt-10 flex flex-wrap items-center gap-3" style={{ animationDelay: "120ms" }}>
        <button
          type="button"
          onClick={() => startAsking(() => router.refresh())}
          disabled={asking}
          className="rounded-[8px] bg-accent px-5 py-3 text-xs font-semibold uppercase tracking-[0.16em] text-accent-ink transition-transform duration-200 hover:-translate-y-0.5 disabled:translate-y-0 disabled:cursor-wait disabled:opacity-60"
        >
          {retry}
        </button>
        <NextLink
          href={exploreHref}
          className="rounded-[8px] border border-line-strong px-5 py-3 font-mono text-[11px] uppercase tracking-[0.18em] text-text transition-colors duration-200 hover:border-accent hover:text-accent"
        >
          {explore}
        </NextLink>
      </nav>

      <details className="rise group mt-10 max-w-[60ch]" style={{ animationDelay: "180ms" }}>
        <summary className="tap cursor-pointer list-none font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint transition-colors duration-200 hover:text-accent [&::-webkit-details-marker]:hidden">
          <span aria-hidden className="me-2 inline-block transition-transform duration-200 group-open:rotate-90">
            &rsaquo;
          </span>
          {details}
        </summary>
        <p className="mt-3 break-words font-mono text-[11px] leading-relaxed text-text-faint">{reason}</p>
      </details>
    </div>
  );
}
