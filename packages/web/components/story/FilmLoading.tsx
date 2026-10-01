import { useTranslations } from "next-intl";
import { FILM_STYLE, FILM_STYLE_HREF } from "@/components/story/room";

/**
 * The film's box while its code is on its way.
 *
 * It is the film's own height and ground, and it already carries the chapter
 * title where the film's opening will draw it, so a reader who scrolls down
 * before the film has arrived sees the chapter begin rather than an empty box.
 * It carries the film's own style, so with no script at all the box is the
 * page's Linen with the title on it, never a black screen.
 */
export function FilmLoading() {
  const t = useTranslations("story.chapter");

  return (
    <div data-film-room className="grain relative h-[100svh] w-full overflow-hidden bg-bg" data-film="loading">
      <style href={FILM_STYLE_HREF} precedence="default">
        {FILM_STYLE}
      </style>
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_62%_40%,color-mix(in_srgb,var(--accent)_8%,transparent),transparent_62%)]"
      />
      <div data-beat="opening" className="film-lower px-5 sm:px-8 lg:px-14">
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
