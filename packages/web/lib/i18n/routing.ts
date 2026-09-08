import { defineRouting } from "next-intl/routing";
import { createNavigation } from "next-intl/navigation";

/**
 * Every page lives under a locale segment. Adding a language is two lines: the
 * code here and a matching file in messages/.
 */
export const routing = defineRouting({
  locales: ["en", "ta"],
  defaultLocale: "en",
});

export type Locale = (typeof routing.locales)[number];

/** Locale-aware replacements for next/link and the router. */
export const { Link, redirect, usePathname, useRouter, getPathname } = createNavigation(routing);
