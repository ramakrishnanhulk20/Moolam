import { IBM_Plex_Mono, Noto_Sans_Tamil, Space_Grotesk } from "next/font/google";

/**
 * Two faces and a mono, self-hosted at build time by next/font.
 *
 * Swapping either face is one line here: the rest of the app only ever reads
 * the CSS variables, never a font name.
 */
export const display = Space_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-display",
  display: "swap",
});

/**
 * Headlines and body share one face on purpose. It is what keeps a page reading
 * as a single object rather than a headline sitting on top of unrelated text.
 * next/font serves both variables from the same downloaded files.
 */
export const body = Space_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-body",
  display: "swap",
});

/** Labels, hashes, addresses and ids only. Never body copy. */
export const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
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
