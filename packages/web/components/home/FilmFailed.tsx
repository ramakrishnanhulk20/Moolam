"use client";

import { useTranslations } from "next-intl";

/**
 * What stands where the film would be when its code did not arrive.
 *
 * It is a short strip in the page's own theme and carries no data-story
 * attribute, so the header, the footer and the bar behave as they do on any
 * page without the film, and the footer sits right under it instead of a
 * screen of empty black away.
 */
export function FilmFailed({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations("story.failed");

  return (
    <section data-motif="seal" data-film-failed className="border-t border-line bg-bg">
      <div className="mx-auto flex w-full max-w-[100rem] flex-wrap items-center gap-x-6 gap-y-4 px-5 py-10 sm:px-8 lg:px-14 lg:py-12">
        <span aria-hidden className="motif rise h-4 w-4 shrink-0" />
        <p role="status" className="rise text-base leading-relaxed text-text-muted" style={{ animationDelay: "60ms" }}>
          {t("line")}
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="rise rounded-[8px] border border-line-strong px-5 py-3 font-mono text-[11px] uppercase tracking-[0.18em] text-text transition-colors duration-200 hover:border-accent hover:text-accent focus-visible:border-accent focus-visible:text-accent"
          style={{ animationDelay: "120ms" }}
        >
          {t("retry")}
        </button>
      </div>
    </section>
  );
}
