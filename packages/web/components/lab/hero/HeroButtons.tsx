"use client";

import { useTranslations } from "next-intl";
import { Link } from "@/lib/i18n/routing";

/**
 * The first screen's two calls: make one, or check one.
 *
 * The classes are the closing card's own, so the film opens and closes on the
 * same pair of buttons rather than on two that nearly match. The entrance is
 * the film's own story-enter rule, the same one the kicker, the title and the
 * tagline rise on, and it moves opacity and transform only, so the row holds
 * its place from the first paint and nothing under it moves when it lands.
 */
export function HeroButtons({ delay = 0, className = "" }: { delay?: number; className?: string }) {
  const t = useTranslations("home.hero");

  return (
    <div
      className={`story-enter pointer-events-auto flex flex-wrap items-center gap-2 sm:gap-3 ${className}`}
      style={{ animationDelay: `${delay}ms` }}
    >
      {/* The studio carries the wallet SDK. Left to prefetch, it would pull
          about 130 kB of it behind every reading of the film, so it loads on
          the tap. The query opens the studio on the generate panel. */}
      <Link
        href={{ pathname: "/studio", query: { mode: "generate" } }}
        prefetch={false}
        className="group inline-flex items-center gap-2 rounded-[8px] bg-accent px-2 py-2.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-accent-ink transition-transform duration-200 hover:scale-[1.03] sm:px-6 sm:py-3.5 sm:text-[11px] sm:tracking-[0.18em]"
      >
        {t("generate")}
        <span aria-hidden className="transition-transform duration-200 group-hover:translate-x-1">
          &rarr;
        </span>
      </Link>
      <Link
        href="/verify"
        className="rounded-[8px] border border-line px-2 py-2.5 text-[10px] uppercase tracking-[0.06em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent sm:px-6 sm:py-3.5 sm:text-[11px] sm:tracking-[0.18em]"
      >
        {t("verify")}
      </Link>
    </div>
  );
}
