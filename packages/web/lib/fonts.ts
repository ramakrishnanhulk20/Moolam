import { Archivo, IBM_Plex_Mono, Inter, Noto_Sans_Tamil } from "next/font/google";

/**
 * A display face with weight in it, a quiet body face, and a mono for figures.
 *
 * Swapping any of them is one line here: the rest of the app only ever reads
 * the CSS variables, never a font name.
 */
export const display = Archivo({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-display",
  display: "swap",
});

/** Body copy and UI text. Never headlines. */
export const body = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-body",
  display: "swap",
});

/** Labels, hashes, addresses, ids and every readout. Never body copy. */
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
