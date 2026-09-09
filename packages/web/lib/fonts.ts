import {
  Archivo,
  IBM_Plex_Mono,
  Inter,
  Noto_Sans_Devanagari,
  Noto_Sans_JP,
  Noto_Sans_KR,
  Noto_Sans_SC,
  Noto_Sans_Tamil,
} from "next/font/google";
import type { Locale } from "@/lib/i18n/routing";

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

/**
 * The Latin faces carry no Tamil, Devanagari, Chinese, Japanese or Korean
 * glyphs, so each of those languages brings its own face as the next link in
 * the stack. They all define the same variable, --font-script, because only one
 * of them is ever on the page: the layout puts a single class on <html> for the
 * locale being read.
 *
 * preload is off on every one of them. A preload link is emitted for every page
 * that carries the stylesheet, which would make an English reader fetch a Tamil
 * font they will never see. With it off, the browser fetches a face only when
 * it has a glyph to draw with it.
 */
const tamil = Noto_Sans_Tamil({
  subsets: ["tamil"],
  variable: "--font-script",
  display: "swap",
  preload: false,
});

const devanagari = Noto_Sans_Devanagari({
  subsets: ["devanagari"],
  variable: "--font-script",
  display: "swap",
  preload: false,
});

// Google splits the CJK families into about a hundred ranges each and names
// none of them, so there is no subset to ask for. The @font-face rules carry
// the unicode ranges and the browser fetches only the handful of ranges the
// page actually draws.
const chineseSimplified = Noto_Sans_SC({
  variable: "--font-script",
  display: "swap",
  preload: false,
});

const japanese = Noto_Sans_JP({
  variable: "--font-script",
  display: "swap",
  preload: false,
});

const korean = Noto_Sans_KR({
  variable: "--font-script",
  display: "swap",
  preload: false,
});

const scriptFonts: Partial<Record<Locale, string>> = {
  ta: tamil.variable,
  hi: devanagari.variable,
  zh: chineseSimplified.variable,
  ja: japanese.variable,
  ko: korean.variable,
};

/** The one script face this locale needs, or nothing for the Latin languages. */
export function scriptFontClass(locale: string): string {
  return scriptFonts[locale as Locale] ?? "";
}

export const fontVariables = [display.variable, body.variable, mono.variable].join(" ");
