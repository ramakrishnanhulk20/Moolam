import { defineRouting } from "next-intl/routing";
import { createNavigation } from "next-intl/navigation";

/**
 * Every page lives under a locale segment. Adding a language is two lines: the
 * code here and a matching file in messages/.
 */
export const routing = defineRouting({
  locales: ["en", "ta", "hi", "zh", "ja", "ko", "es", "fr", "de", "pt"],
  defaultLocale: "en",
});

export type Locale = (typeof routing.locales)[number];

/**
 * Each language named in its own script, so a reader recognises theirs without
 * knowing English. These live here rather than in the message files: the name
 * of a language does not change with the language you are reading the site in.
 */
export const localeLabels: Record<Locale, string> = {
  en: "English",
  ta: "தமிழ்",
  hi: "हिन्दी",
  zh: "简体中文",
  ja: "日本語",
  ko: "한국어",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  pt: "Português",
};

/** Locale-aware replacements for next/link and the router. */
export const { Link, redirect, usePathname, useRouter, getPathname } = createNavigation(routing);
