import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

/**
 * The film's place on the page.
 *
 * Under the dark theme this draws nothing of its own: the film runs full bleed
 * and opens on its chapter title inside the shot. Under the light theme the
 * film is a dark screen set into the cream page, with 32 px of page round it
 * (16 px on a phone), 8 px corners and a hairline, and the chapter title stands
 * above it on the page. The stylesheet does all of that switching (.story-frame
 * in globals.css), so the server's markup is the same in both themes and
 * nothing moves when the theme is read.
 *
 * The title enters on the stylesheet's own rise, driven by the scroll where the
 * browser can, so the server's markup never hides it behind an opacity only a
 * script would lift. It wraps the film's box and the film alike, so the title
 * does not rise a second time when the box is swapped for the film.
 */
export function FilmFrame({ children }: { children: ReactNode }) {
  const t = useTranslations("story.chapter");

  return (
    <section className="story-frame" data-story-frame>
      <div className="story-frame-title rise px-5 pb-8 pt-16 sm:px-8 sm:pb-10 lg:px-14 lg:pt-20">
        <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-accent">
          <span className="motif h-[9px] w-[9px]" />
          {t("kicker")}
        </p>
        <h2 className="mt-4 max-w-[16ch] font-display text-[clamp(2rem,5.4vw,4.4rem)] font-semibold leading-[0.98] tracking-[-0.04em] text-text">
          {t("title")}
        </h2>
      </div>
      {children}
    </section>
  );
}
