import { useLocale, useTranslations } from "next-intl";
import { Link } from "@/lib/i18n/routing";

/**
 * The headline's own entrance: it rises into place without fading in.
 *
 * A browser does not count text that is painted at no opacity as the page's
 * largest paint, and it does not go back and count it once a fade has lifted
 * it. With the shared fade the phone's largest paint was a sample picture at
 * five seconds, where the headline had been on the screen since the first one.
 * A reader who asked for less motion gets it standing still, through the
 * site's own rule that cuts every animation short.
 */
const LIFT = `
@keyframes first-lift { from { transform: translateY(0.35em); } to { transform: none; } }
.first-lift { animation: first-lift 0.9s cubic-bezier(0.16, 1, 0.3, 1) both; }
`;

/**
 * The why and the headline, drawn on the server so a slow phone reads them from
 * the first byte. They rise on CSS, never on script, and a reader who asked for
 * less motion gets them standing still.
 *
 * The line under the headline says strip, shrink and screenshot, and not crop.
 * The verifier's own degrade ladder finds a stripped, a halved and a
 * screenshotted copy at 0 bits and misses a 10 percent crop outright, so a crop
 * is a promise the product only keeps for a sliver of one. Every language says
 * the same three.
 */
export function Headline({ size, className = "" }: { size: "poster" | "board"; className?: string }) {
  const t = useTranslations("home.first");
  const brand = useTranslations("header");
  const locale = useLocale();
  const tamil = locale === "ta";
  const board = boardType([...`${t("headline")} ${t("headlineTail")}`].length, locale);

  return (
    <div className={className}>
      <style href="moolam-first-lift" precedence="default">
        {LIFT}
      </style>
      <p className="rise flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.28em] text-accent">
        <span className="motif h-[10px] w-[10px]" />
        {brand("brand")}
      </p>
      {/* data-hero-words: the words that say what this is. The first-visit
          walk keeps its card off them as it does off the two calls; on a
          phone it may lie on the line (components/guide/place.ts). */}
      <h1
        data-first-line
        data-hero-words="headline"
        style={{ animationDelay: "70ms" }}
        className={`first-lift mt-5 font-display font-semibold uppercase tracking-[-0.045em] lg:mt-4 ${
          tamil ? "leading-[1.16]" : "leading-[0.9]"
        } ${size === "poster" ? "max-w-[14ch] text-[clamp(2.75rem,6.4vw,7rem)]" : board}`}
      >
        {t("headline")} <span className="text-accent">{t("headlineTail")}</span>
      </h1>
      <p
        data-first-why
        data-hero-words="line"
        className="rise mt-6 max-w-[52ch] text-base leading-relaxed text-text-muted sm:text-[1.075rem] lg:mt-4"
        style={{ animationDelay: "160ms" }}
      >
        {t("line")}
      </p>
    </div>
  );
}

/**
 * The board's headline size, stepped down for a longer sentence.
 *
 * The English line is 49 characters and fills four lines of the left half at
 * 1440 px, with the drop, the three passports and the second call under it on
 * the first screen. French, Spanish and Portuguese say the same thing in up to
 * 60, and Tamil's letters stand taller and need more room between the lines,
 * so each steps the type down just far enough to keep the same screen.
 */
function boardType(length: number, locale: string): string {
  const wide = locale === "ta" || locale === "ja";
  const step = (length <= 52 ? 0 : length <= 60 ? 1 : 2) + (wide ? 1 : 0);
  // The measure is counted in Latin zeros, and a Tamil word is two or three of
  // those wide, so Tamil takes the whole half instead. Japanese takes it too:
  // it breaks only between phrases, and in 15 zeros its headline set in four
  // lines and pushed Make one below the first screen at 1440 by 900. The whole
  // half one step down sets it in three, each line a whole phrase.
  const measure = wide ? "max-w-none" : ["max-w-[15ch]", "max-w-[16ch]", "max-w-[17ch]", "max-w-[18ch]"][Math.min(step, 3)];
  const size = [
    "text-[clamp(2.6rem,4.3vw,4.6rem)]",
    "text-[clamp(2.4rem,3.8vw,4.1rem)]",
    "text-[clamp(2.2rem,3.4vw,3.7rem)]",
    "text-[clamp(2rem,3vw,3.3rem)]",
  ][Math.min(step, 3)];
  return `${measure} ${size}`;
}

/**
 * The look every quiet button on the first screen and the film shares with the
 * site's other secondary buttons (the film's Try again, the error and missing
 * pages): outlined, 44 px tall, 11 px mono capitals at the same tracking.
 */
export const SECONDARY_BUTTON =
  "inline-flex min-h-11 items-center justify-center rounded-[8px] border border-line-strong px-5 py-2 font-mono text-[11px] uppercase tracking-[0.18em] text-text transition-colors duration-200 hover:border-accent hover:text-accent focus-visible:border-accent focus-visible:text-accent disabled:cursor-wait disabled:opacity-50";

/**
 * The second call: make a passport of your own.
 *
 * Solid, in the page's own two colours turned round, so it reads as a real
 * button beside Choose an image without taking the accent, which stays the
 * mark of the one lead action.
 */
export function MakeOne({ className = "" }: { className?: string }) {
  const t = useTranslations("home.first");

  return (
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-2 ${className}`}>
      <Link
        href="/studio"
        prefetch={false}
        data-hero-call="make"
        className="group inline-flex h-11 items-center gap-3 rounded-[8px] bg-text px-6 text-xs font-semibold uppercase tracking-[0.14em] text-bg transition duration-200 hover:-translate-y-0.5 hover:opacity-90 active:translate-y-0"
      >
        {t("make")}
        {/* The arrow slides rather than grows, so the button keeps its width under the pointer. */}
        <span
          aria-hidden
          className="block h-px w-5 bg-current transition-transform duration-300 group-hover:translate-x-1.5 group-focus-visible:translate-x-1.5"
        />
      </Link>
      <span className="text-base text-text-faint">{t("makeNote")}</span>
    </div>
  );
}
