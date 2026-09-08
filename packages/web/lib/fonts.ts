import { Anton, Inter_Tight, JetBrains_Mono, Noto_Sans_Tamil } from "next/font/google";

/**
 * Two faces and a mono, self-hosted at build time by next/font.
 *
 * Swapping either face is one line here: the rest of the app only ever reads
 * the CSS variables, never a font name.
 */
export const display = Anton({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-display",
  display: "swap",
});

export const body = Inter_Tight({
  subsets: ["latin"],
  variable: "--font-body",
  display: "swap",
});

/** Hashes, addresses and ids only. Never body copy. */
export const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

/** Tamil has no glyphs in the two Latin faces, so it gets its own, used as the
 *  next link in the font stack rather than a separate rule. */
export const tamil = Noto_Sans_Tamil({
  subsets: ["tamil"],
  variable: "--font-tamil",
  display: "swap",
});

export const fontVariables = [display.variable, body.variable, mono.variable, tamil.variable].join(" ");
