"use client";

import { useTheme } from "next-themes";
import { useEffect } from "react";
import { themeScriptType } from "@/components/providers/ThemeProvider";
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
 * The few lines that set the bar before the first paint. The head carries the
 * light colour, which is right for every first visit; a reader who chose dark
 * would otherwise see a cream bar over a black page until React woke up. It
 * runs after the theme script, so the class on the html tag is already the
 * one the page will paint with.
 */
export function themeBarScript(): string {
  return `(function(d,l){var c=document.documentElement.classList.contains("dark")?d:l;var m=document.querySelectorAll('meta[name="theme-color"]');for(var i=0;i<m.length;i++){m[i].content=c}})(${JSON.stringify(THEME_BAR.dark)},${JSON.stringify(THEME_BAR.light)})`;
}

/**
 * Keeps the browser's own top bar in the page's colour, whichever theme is in
 * use.
 *
 * The script covers the first paint and this effect covers every press of the
 * switch after it. The route is watched as well, in case a navigation hands
 * the head back its server copy.
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

  // Marked as plain text when React draws it in the browser, for the reason
  // themeScriptType gives: only the copy in the server's HTML ever runs.
  return (
    <script
      type={themeScriptType()}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: themeBarScript() }}
    />
  );
}
