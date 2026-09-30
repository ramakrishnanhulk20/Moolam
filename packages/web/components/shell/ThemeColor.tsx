"use client";

import { useTheme } from "next-themes";
import { useEffect } from "react";
import { usePathname } from "@/lib/i18n/routing";

/** The --bg each theme paints the page with in globals.css, which the phone's own bar should match. */
export const THEME_BAR: Record<"dark" | "light", string> = {
  dark: "#08080a",
  light: "#e4ddd0",
};

/** The bar colour for the theme the reader ended up with, or null before the browser knows it. */
export function themeBarColour(resolved: string | undefined): string | null {
  return resolved === "dark" || resolved === "light" ? THEME_BAR[resolved] : null;
}

/**
 * Keeps the browser's own top bar in the page's colour once the reader has
 * picked a theme.
 *
 * The two theme-color tags in the head choose by the system setting, which is
 * right until somebody presses the toggle: a phone set to dark kept a black bar
 * over a cream page. Both tags are rewritten, so whichever one the browser is
 * reading carries the choice. The route is watched as well, in case a
 * navigation hands the head back its server copies.
 */
export function ThemeColor() {
  const { resolvedTheme } = useTheme();
  const here = usePathname();

  useEffect(() => {
    const colour = themeBarColour(resolvedTheme);
    if (colour === null) {
      return;
    }
    for (const tag of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
      tag.content = colour;
    }
  }, [resolvedTheme, here]);

  return null;
}
