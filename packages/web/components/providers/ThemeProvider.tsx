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

/**
 * Dark is the product's real palette, so the system setting is ignored and the
 * light theme is something a person asks for with the toggle.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <NextThemes
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      scriptProps={{ type: themeScriptType() }}
    >
      {children}
    </NextThemes>
  );
}
