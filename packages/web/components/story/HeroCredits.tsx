"use client";

import { useReducedMotion } from "framer-motion";
import { useTranslations } from "next-intl";
import { useState, type CSSProperties } from "react";
import { Link } from "@/lib/i18n/routing";

/** How far the buttons trail the label, in milliseconds. The film's own stagger. */
const TRAIL = 100;

/**
 * The first screen's credits: one line, then the two calls under it.
 *
 * The buttons carry the closing card's classes, so the film opens and closes on
 * the same pair rather than on two that nearly match. The block holds its full
 * size from the first paint whether it has entered or not, so nothing below it
 * moves when it lands, and only the two links take a pointer: the rest of the
 * strip belongs to the film's scroll.
 */
export function HeroCredits({ entered }: { entered: boolean }) {
  const t = useTranslations("home.hero");
  const reduced = useReducedMotion();
  const [risen, setRisen] = useState(false);

  // The first screen has painted its words once the title has settled and the
  // two calls under it have finished rising, and this is the one place that
  // knows both. The first-visit guide waits for the mark: on a slow phone it
  // used to arrive seconds before the hero it introduces, over a black page.
  const painted = entered && (reduced === true || risen);

  // Someone who has asked for less motion is simply given the block. Everyone
  // else gets the film's own rise, started the moment the title has settled.
  // Before it starts, the waiting state is the first frame of that same rise,
  // which is why the block takes its full room from the first paint.
  const enter = (delay: number): { className: string; style?: CSSProperties } => {
    if (reduced === true) {
      return { className: "" };
    }
    if (!entered) {
      return { className: "", style: { opacity: 0, transform: "translateY(28px)" } };
    }
    return { className: "story-enter", style: delay === 0 ? undefined : { animationDelay: `${delay}ms` } };
  };

  const label = enter(0);
  const row = enter(TRAIL);

  return (
    <div className="pointer-events-none w-fit" data-hero-shown={painted ? "true" : undefined}>
      <p
        className={`font-mono text-[11px] uppercase tracking-[0.24em] text-text-faint ${label.className}`}
        style={label.style}
      >
        {t("credit")}
      </p>
      <div
        className={`mt-4 flex flex-wrap items-center gap-2 sm:gap-3 ${row.className}`}
        style={row.style}
        onAnimationEnd={(event) => {
          if (event.target === event.currentTarget) {
            setRisen(true);
          }
        }}
      >
        {/* The studio carries the wallet SDK. Left to prefetch, it would pull
            about 130 kB of it behind every reading of the film, so it loads on
            the tap. The query opens the studio on the generate panel.

            data-hero-call is what the first-visit guide reads to keep its card
            off these two: a visitor it has just told what the site does must
            still be able to press the button that does it. */}
        <Link
          href={{ pathname: "/studio", query: { mode: "generate" } }}
          prefetch={false}
          data-hero-call="generate"
          className="group pointer-events-auto inline-flex items-center gap-2 rounded-[8px] bg-accent px-2 py-2.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-accent-ink transition-transform duration-200 hover:scale-[1.03] sm:px-6 sm:py-3.5 sm:text-[11px] sm:tracking-[0.18em]"
        >
          {t("generate")}
          <span aria-hidden className="transition-transform duration-200 group-hover:translate-x-1">
            &rarr;
          </span>
        </Link>
        <Link
          href="/verify"
          data-hero-call="verify"
          className="pointer-events-auto rounded-[8px] border border-line px-2 py-2.5 text-[10px] uppercase tracking-[0.06em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent sm:px-6 sm:py-3.5 sm:text-[11px] sm:tracking-[0.18em]"
        >
          {t("verify")}
        </Link>
      </div>
    </div>
  );
}
