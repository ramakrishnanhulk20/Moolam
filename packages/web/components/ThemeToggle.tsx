"use client";

import { useTheme } from "next-themes";
import { useTranslations } from "next-intl";

/**
 * Which label shows is decided by CSS from the class next-themes puts on the
 * html tag, not by React state. That way the button is correct in the very
 * first painted frame and the server markup never disagrees with the browser.
 */
export function ThemeToggle() {
  const t = useTranslations("header");
  const { resolvedTheme, setTheme } = useTheme();

  return (
    <button
      type="button"
      aria-label={t("theme")}
      onClick={() => setTheme(resolvedTheme === "light" ? "dark" : "light")}
      className="rounded-[8px] border border-line px-3 py-1.5 text-xs uppercase tracking-[0.18em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent"
    >
      <span className="hidden dark:inline">{t("themeLight")}</span>
      <span className="inline dark:hidden">{t("themeDark")}</span>
    </button>
  );
}
