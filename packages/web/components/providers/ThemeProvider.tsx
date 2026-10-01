"use client";

import { ThemeProvider as NextThemes } from "next-themes";
import type { ReactNode } from "react";

/**
 * What the theme script is marked as, by where it is drawn.
 *
 * next-themes writes a small script that puts the saved theme on the page
 * before first paint. It only ever runs from the server's HTML. When React has
 * to draw the page in the browser from scratch, which the dev server does for
 * every 404 because its server render stops at the miss, the same script is
 * created again, can never run there, and React warns about a script tag in a
 * component. Drawn in the browser it is marked as plain text, which React
 * treats as data, and the one that matters, in the server's HTML, is unchanged.
 * The script carries suppressHydrationWarning, so the two marks do not clash.
 */
export function themeScriptType(): string {
  return typeof window === "undefined" ? "text/javascript" : "text/plain";
}

/** The theme a visitor who has never pressed the switch is shown. */
export const DEFAULT_THEME = "light";

/** Where next-themes keeps a visitor's own choice. */
export const THEME_STORAGE_KEY = "theme";

/**
 * Light for everyone on a first visit, whatever the device asks for. The
 * switch offers light and dark and nothing else,
 * so the device setting is never read, and a choice made with the switch is
 * kept in this browser and wins on every visit after.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <NextThemes
      attribute="class"
      defaultTheme={DEFAULT_THEME}
      enableSystem={false}
      storageKey={THEME_STORAGE_KEY}
      disableTransitionOnChange
      scriptProps={{ type: themeScriptType() }}
    >
      {children}
    </NextThemes>
  );
}
