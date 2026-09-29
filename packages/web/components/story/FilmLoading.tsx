import { useTranslations } from "next-intl";

/**
 * The film's box while its code is on its way.
 *
 * It is the film's own height and ground, and it already carries the chapter
 * title where the film's opening will draw it, so a reader who scrolls down
 * before the film has arrived sees the chapter begin rather than a window of
 * black. It carries data-story, which the page's story rules hang on, so the
 * first screen's pull-up is right from the first paint (see StoryStage.tsx).
 *
 * The words are marked as the opening, so under the light theme, where the
 * title stands above the framed screen instead, they are not drawn twice.
 */
export function FilmLoading() {
  const t = useTranslations("story.chapter");

  return (
    <div className="grain relative h-[100svh] w-full overflow-hidden bg-bg" data-story="loading">
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_62%_40%,rgb(255_183_197/0.08),transparent_62%)]"
      />
      <div data-beat="opening" className="story-lower px-5 sm:px-8 lg:px-14">
        <div className="mx-auto w-full max-w-[100rem]">
          <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-accent">
            <span className="motif h-[9px] w-[9px]" />
            {t("kicker")}
          </p>
          <p className="mt-5 max-w-[12ch] font-display text-[clamp(2rem,5.4vw,4.4rem)] font-semibold leading-[0.98] tracking-[-0.04em] text-text">
            {t("title")}
          </p>
        </div>
      </div>
    </div>
  );
}
