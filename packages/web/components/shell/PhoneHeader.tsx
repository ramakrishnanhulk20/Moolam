"use client";

import Image from "next/image";
import { useTheme } from "next-themes";
import { useTranslations } from "next-intl";
import { LocaleSwitch } from "@/components/LocaleSwitch";
import { Link } from "@/lib/i18n/routing";

/**
 * The bar over a phone screen once the tabs are at the bottom: the wordmark,
 * the language and the theme. Nothing else.
 *
 * The menu button it replaces existed to hold seven links a row could not fit.
 * The tab bar holds five of them in sight all the time, so the button has
 * nothing left to open and the top of the screen goes back to the page.
 *
 * The row is 55 px and its rule one more, which is the 56 px --header-h in
 * globals.css says a phone header is. The film pulls itself up by exactly that
 * number, so the two must stay equal.
 */
export function PhoneHeader({ brand, className = "" }: { brand: string; className?: string }) {
  return (
    <header
      className={`sticky top-0 z-40 border-b border-line bg-bg/85 backdrop-blur-md ${className}`}
    >
      <div className="flex h-[55px] w-full items-center gap-4 px-5">
        {/* The lockup files carry clear space on every side, so the box is 63 px
            tall for 24 px of cap height and the negative margin keeps the row
            the height the ink asks for. The theme class picks the variant on
            every page, the home film included, because the film follows the
            page's theme. */}
        <Link href="/" className="-my-[18px] flex items-center transition-opacity duration-200 hover:opacity-70">
          <Image
            src="/brand/kolam/lockup-horizontal-dark.svg"
            alt={brand}
            width={160}
            height={63}
            unoptimized
            loading="eager"
            data-lockup="dark"
            className="hidden dark:block"
          />
          <Image
            src="/brand/kolam/lockup-horizontal-light.svg"
            alt={brand}
            width={160}
            height={63}
            unoptimized
            loading="eager"
            fetchPriority="high"
            data-lockup="light"
            className="block dark:hidden"
          />
        </Link>

        {/* The language chip is drawn small on purpose and grown to a 44 px
            target by the tap-row rule in globals.css. The theme square carries
            its own pad, which that rule would narrow to the square's width. */}
        <div className="ms-auto flex items-center gap-2">
          <div className="tap-row flex items-center">
            <LocaleSwitch />
          </div>
          <PhoneThemeSquare />
        </div>
      </div>
    </header>
  );
}

const SQUARE =
  "relative h-[30px] w-[30px] shrink-0 place-items-center rounded-[8px] border border-line text-text-muted transition-colors duration-200 after:absolute after:-inset-[7px] after:content-[''] hover:border-accent hover:text-accent";

/**
 * The theme as a mark rather than a word. "Theme: dark" in Tamil is wider than
 * a 375 px row leaves beside the logo and the language, so the chip was cut on
 * every page. The mark shows the theme you are in, a moon or a sun, and the
 * whole sentence the laptop chip says is still the name a screen reader hears
 * and the title a long press shows.
 *
 * Two buttons, as in ThemeToggle, so the class next-themes sets on the html tag
 * picks the right one in the first painted frame.
 */
function PhoneThemeSquare() {
  const t = useTranslations("header");
  const { setTheme } = useTheme();

  return (
    <>
      <button
        type="button"
        title={t("themeDarkAction")}
        aria-label={t("themeDarkAction")}
        onClick={() => setTheme("light")}
        className={`hidden dark:grid ${SQUARE}`}
      >
        <ThemeMark name="moon" />
      </button>
      <button
        type="button"
        title={t("themeLightAction")}
        aria-label={t("themeLightAction")}
        onClick={() => setTheme("dark")}
        className={`grid dark:hidden ${SQUARE}`}
      >
        <ThemeMark name="sun" />
      </button>
    </>
  );
}

/** Drawn with the tab marks' pen: one weight of line, square ends, a filled square at the heart of the sun. That square is the pen's, not the kolam mark's. */
function ThemeMark({ name }: { name: "sun" | "moon" }) {
  return (
    <svg
      aria-hidden
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="square"
      strokeLinejoin="miter"
      shapeRendering="geometricPrecision"
    >
      {name === "sun" ? (
        <>
          <rect x="8.5" y="8.5" width="7" height="7" fill="currentColor" stroke="none" />
          <line x1="12" y1="2.5" x2="12" y2="5" />
          <line x1="12" y1="19" x2="12" y2="21.5" />
          <line x1="2.5" y1="12" x2="5" y2="12" />
          <line x1="19" y1="12" x2="21.5" y2="12" />
          <line x1="5.3" y1="5.3" x2="6.8" y2="6.8" />
          <line x1="17.2" y1="17.2" x2="18.7" y2="18.7" />
          <line x1="5.3" y1="18.7" x2="6.8" y2="17.2" />
          <line x1="17.2" y1="6.8" x2="18.7" y2="5.3" />
        </>
      ) : (
        <path d="M19.5 14.6A8 8 0 1 1 9.4 4.5a6.4 6.4 0 0 0 10.1 10.1Z" />
      )}
    </svg>
  );
}
