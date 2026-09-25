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
  const tamil = useLocale() === "ta";
  const board = boardType([...`${t("headline")} ${t("headlineTail")}`].length, tamil);

  return (
    <div className={className}>
      <style href="moolam-first-lift" precedence="default">
        {LIFT}
      </style>
      <p className="rise flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.28em] text-accent">
        <span className="motif h-[10px] w-[10px]" />
        {brand("brand")}
      </p>
      <h1
        data-first-line
        style={{ animationDelay: "70ms" }}
        className={`first-lift mt-5 font-display font-semibold uppercase tracking-[-0.045em] lg:mt-4 ${
          tamil ? "leading-[1.16]" : "leading-[0.9]"
        } ${size === "poster" ? "max-w-[14ch] text-[clamp(2.75rem,6.4vw,7rem)]" : board}`}
      >
        {t("headline")} <span className="text-accent">{t("headlineTail")}</span>
      </h1>
      <p
        data-first-why
        className="rise mt-6 max-w-[52ch] text-base leading-relaxed text-text-muted sm:text-[1.075rem] lg:mt-5"
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
function boardType(length: number, tamil: boolean): string {
  const step = (length <= 52 ? 0 : length <= 60 ? 1 : 2) + (tamil ? 1 : 0);
  // The measure is counted in Latin zeros, and a Tamil word is two or three of
  // those wide, so Tamil takes the whole half instead.
  const measure = tamil ? "max-w-none" : ["max-w-[15ch]", "max-w-[16ch]", "max-w-[17ch]", "max-w-[18ch]"][Math.min(step, 3)];
  const size = [
    "text-[clamp(2.6rem,4.3vw,4.6rem)]",
    "text-[clamp(2.4rem,3.8vw,4.1rem)]",
    "text-[clamp(2.2rem,3.4vw,3.7rem)]",
    "text-[clamp(2rem,3vw,3.3rem)]",
  ][Math.min(step, 3)];
  return `${measure} ${size}`;
}

/** The small second call: make a passport of your own. */
export function MakeOne({ className = "" }: { className?: string }) {
  const t = useTranslations("home.first");

  return (
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-2 ${className}`}>
      <Link
        href="/studio"
        prefetch={false}
        data-hero-call="make"
        className="group inline-flex h-11 items-center gap-3 rounded-[8px] border border-line-strong px-5 text-[11px] font-semibold uppercase tracking-[0.18em] text-text transition-colors duration-200 hover:border-accent hover:text-accent"
      >
        {t("make")}
        <span aria-hidden className="block h-px w-5 bg-current transition-all duration-300 group-hover:w-8" />
      </Link>
      <span className="text-xs text-text-faint">{t("makeNote")}</span>
    </div>
  );
}
