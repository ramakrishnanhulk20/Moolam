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
 * The few lines that set the bar before the first paint. The head carries one
 * tag for each device setting, which is right for a first visit; a reader whose
 * switch disagrees with their device would otherwise see a cream bar over a
 * black page, or the other way round, until React woke up. Every tag is set to
 * the same colour, so whichever one the device matches says what the page
 * shows. It runs after the theme script, so the class on the html tag is
 * already the one the page will paint with.
 */
export function themeBarScript(): string {
  return `(function(d,l){var c=document.documentElement.classList.contains("dark")?d:l;var m=document.querySelectorAll('meta[name="theme-color"]');for(var i=0;i<m.length;i++){m[i].content=c}})(${JSON.stringify(THEME_BAR.dark)},${JSON.stringify(THEME_BAR.light)})`;
}

/**
 * Keeps the browser's own top bar in the page's colour, whichever theme is in
 * use.
 *
 * The script covers the first paint and this effect covers every press of the
 * switch after it. The head is watched as well: when the page changes, Next
 * puts its own copy of the tags back after this effect has run, with the server's
 * colours, and a phone set to light but shown dark would be handed the cream
 * tag again. Setting a tag to the colour it already has changes nothing, so
 * the watch cannot feed itself.
 */
export function ThemeColor() {
  const { resolvedTheme } = useTheme();
  const here = usePathname();

  useEffect(() => {
    const colour = themeBarColour(resolvedTheme);
    if (colour === null) {
      return;
    }
    const paint = () => {
      for (const tag of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
        if (tag.content !== colour) {
          tag.content = colour;
        }
      }
    };
    paint();
    const watch = new MutationObserver(paint);
    watch.observe(document.head, { childList: true, subtree: true, attributes: true, attributeFilter: ["content"] });
    return () => watch.disconnect();
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
