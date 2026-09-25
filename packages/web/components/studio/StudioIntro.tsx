import { getTranslations } from "next-intl/server";

/**
 * The words at the top of the studio, drawn on the server.
 *
 * They used to be motion components inside the wallet screen, so the served
 * HTML carried them at opacity 0 and a phone waited 11.5 s for script before
 * the lede could paint. Here they are plain markup with the CSS rise, in the
 * first byte, in every language, and the reduced-motion rule in globals.css
 * turns the rise off.
 */
export async function StudioIntro({ locale }: { locale: string }) {
  const t = await getTranslations({ locale, namespace: "studio" });

  // Tamil letters carry marks above and below the line, so the tight leading
  // the display face wants in Latin makes two lines touch.
  const leading = locale === "ta" ? "leading-[1.12]" : "leading-[0.86]";

  return (
    <header className="relative" data-studio-intro>
      <p className="rise flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.28em] text-accent">
        <span className="motif h-[10px] w-[10px]" />
        {t("kicker")}
      </p>

      <h1
        className={`rise mt-6 max-w-[14ch] font-display text-[clamp(2.6rem,8.5vw,6.5rem)] font-semibold uppercase tracking-[-0.035em] ${leading}`}
        style={{ animationDelay: "60ms" }}
      >
        {t("title")}
      </h1>

      <p
        className="rise mt-7 max-w-[52ch] text-base leading-relaxed text-text-muted sm:text-lg"
        style={{ animationDelay: "140ms" }}
      >
        {t("lede")}
      </p>

      <span
        aria-hidden
        className="pointer-events-none absolute right-0 top-2 hidden select-none font-mono text-[11px] uppercase tracking-[0.4em] text-text-faint lg:block"
        style={{ writingMode: "vertical-rl" }}
      >
        {t("rail")}
      </span>
    </header>
  );
}
