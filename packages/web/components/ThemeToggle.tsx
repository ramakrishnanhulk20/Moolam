"use client";

import { useTheme } from "next-themes";
import { useTranslations } from "next-intl";

const SHELL =
  "items-center gap-2 rounded-[8px] border border-line px-3 py-1.5 text-xs uppercase tracking-[0.18em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent";

/** The mark and the name, laid out exactly as the language chip lays out its own. */
const LABEL = "max-w-[14ch] truncate normal-case tracking-[0.06em]";

/**
 * The theme, named as it is right now, with the switch it offers in the label
 * a screen reader hears and in the hover title. That is the same rule the
 * language control follows: the chip says where you are, and what a tap does is
 * spelled out for anyone who needs it said.
 *
 * The two chips sit side by side on a phone, so this one carries the same seal
 * and the same lettering as its neighbour. "Dark" beside "English" read as two
 * opposite conventions: one a state, one an instruction.
 *
 * There are two buttons rather than one, and CSS from the class next-themes
 * puts on the html tag decides which is shown. That way the label and its title
 * are correct in the very first painted frame and the server markup never
 * disagrees with the browser.
 */
export function ThemeToggle() {
  const t = useTranslations("header");
  const { setTheme } = useTheme();

  return (
    <>
      <button
        type="button"
        title={t("themeToLight")}
        aria-label={t("themeDarkAction")}
        onClick={() => setTheme("light")}
        className={`hidden dark:flex ${SHELL}`}
      >
        <span className="motif h-[7px] w-[7px]" aria-hidden />
        <span className={LABEL}>{t("themeDark")}</span>
      </button>
      <button
        type="button"
        title={t("themeToDark")}
        aria-label={t("themeLightAction")}
        onClick={() => setTheme("dark")}
        className={`flex dark:hidden ${SHELL}`}
      >
        <span className="motif h-[7px] w-[7px]" aria-hidden />
        <span className={LABEL}>{t("themeLight")}</span>
      </button>
    </>
  );
}
