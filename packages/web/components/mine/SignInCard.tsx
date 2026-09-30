"use client";

import { useTranslations } from "next-intl";
import { useHeadingLeading } from "@/components/studio/leading";

/**
 * What a signed out visitor sees on /mine.
 *
 * The list on this page is read with an account's own address, so there is
 * nothing to show and nothing to guess at until someone signs in. The card says
 * that in one line and offers the only control that changes it, with the same
 * sign in the studio uses.
 *
 * Its heading was the page's largest paint and waited 16 s on a phone for
 * script, because a motion component served it at opacity 0. It enters with the
 * CSS rise now, so the HTML carries it visible.
 */
export function SignInCard({ onSignIn }: { onSignIn: () => void }) {
  const t = useTranslations("mine");
  const studio = useTranslations("studio");
  const leading = useHeadingLeading("leading-[1.15]", "leading-[1.35]");

  return (
    <section
      data-signed-out
      className="rise relative max-w-[62ch] border border-line bg-bg-raised p-7 sm:p-10"
    >
      {/* The kolam mark, oversized, hung off the card's own corner. The mark itself
          is wrapped rather than positioned: the .motif rule in globals.css sets
          position relative and it is written outside Tailwind's layers, so it
          wins over any position utility put on the same element. */}
      <span aria-hidden className="pointer-events-none absolute -right-5 -top-5 hidden opacity-[0.14] sm:block">
        <span className="motif block h-14 w-14" />
      </span>

      <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-accent">
        <span className="motif h-[9px] w-[9px]" />
        {t("signedOut.kicker")}
      </p>

      {/* The page's title is the only display heading on the page, so the
          card's is a card's: the same words in sentence case, two lines at most. */}
      <h2
        data-card-heading="card"
        className={`mt-4 max-w-[30ch] font-display text-[clamp(1.25rem,2vw,1.6rem)] font-semibold tracking-[-0.02em] ${leading}`}
      >
        {t("signedOut.heading")}
      </h2>

      <div className="rise mt-7 flex flex-wrap items-center gap-x-6 gap-y-3" style={{ animationDelay: "120ms" }}>
        <button
          type="button"
          onClick={onSignIn}
          className="rounded-[8px] bg-accent px-7 py-4 text-sm font-semibold uppercase tracking-[0.14em] text-accent-ink transition-transform duration-200 hover:-translate-y-0.5"
        >
          {t("signedOut.button")}
        </button>
        <p className="max-w-[30ch] text-base leading-relaxed text-text-faint">{studio("signedOut.methods")}</p>
      </div>

      <p className="mt-7 max-w-[54ch] text-base leading-relaxed text-text-muted">{t("signedOut.body")}</p>
    </section>
  );
}
