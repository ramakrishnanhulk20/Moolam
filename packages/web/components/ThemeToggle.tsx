"use client";

import { useTheme } from "next-themes";
import { useTranslations } from "next-intl";

const SHELL =
  "rounded-[8px] border border-line px-3 py-1.5 text-xs uppercase tracking-[0.18em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent";

/**
 * The theme, named as it is right now, with the switch it offers in the hover
 * title. That is the same rule the language control follows: both say where you
 * are, neither says where you would land.
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
        aria-label={t("themeToLight")}
        onClick={() => setTheme("light")}
        className={`hidden dark:inline-block ${SHELL}`}
      >
        {t("themeDark")}
      </button>
      <button
        type="button"
        title={t("themeToDark")}
        aria-label={t("themeToDark")}
        onClick={() => setTheme("dark")}
        className={`inline-block dark:hidden ${SHELL}`}
      >
        {t("themeLight")}
      </button>
    </>
  );
}
