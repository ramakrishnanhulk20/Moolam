import { Archivo, IBM_Plex_Mono, Inter } from "next/font/google";

/**
 * A display face with weight in it, a quiet body face, and a mono for figures.
 *
 * Swapping any of them is one line here: the rest of the app only ever reads
 * the CSS variables, never a font name.
 *
 * The Latin faces carry no Tamil, Devanagari, Chinese, Japanese or Korean
 * glyphs, so each of those languages brings its own face as the next link in
 * the stack. Those five live one per file under lib/fonts/script and are loaded
 * by components/ScriptFace.tsx, never from here: next/font emits its stylesheet
 * wherever the face is imported, and every locale shares one Next route, so a
 * face imported here would put all five sheets on all ten languages.
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

export const fontVariables = [display.variable, body.variable, mono.variable].join(" ");
