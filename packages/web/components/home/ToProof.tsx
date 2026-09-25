"use client";

import { useTranslations } from "next-intl";
import type { MouseEvent } from "react";

/**
 * The phone's pointer from the drop down to the evidence, which sits a scroll
 * below it there. A laptop has the evidence beside the drop and never shows it.
 *
 * It is a plain link to the finding, so it still jumps there before the script
 * has run. Once it has, the page glides instead, unless the reader asked for
 * less motion.
 */
export function ToProof({ count }: { count: number }) {
  const t = useTranslations("home.first");

  function glide(event: MouseEvent<HTMLAnchorElement>) {
    const target = document.getElementById("finding");
    if (target === null) {
      return;
    }
    event.preventDefault();
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ block: "start", behavior: still ? "auto" : "smooth" });
  }

  return (
    <a
      href="#finding"
      onClick={glide}
      data-first-proof
      className="group mt-3 inline-flex min-h-11 items-center gap-2.5 text-sm text-text underline decoration-line-strong underline-offset-4 transition-colors duration-200 hover:text-accent hover:decoration-accent lg:hidden"
    >
      <span>{t("proof", { count })}</span>
      <svg
        aria-hidden
        viewBox="0 0 12 16"
        className="h-4 w-3 shrink-0 text-accent transition-transform duration-300 group-hover:translate-y-1 motion-safe:animate-bounce"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <path d="M6 1v13M1 9l5 5 5-5" />
      </svg>
    </a>
  );
}
