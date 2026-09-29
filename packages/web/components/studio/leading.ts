"use client";

import { useLocale } from "next-intl";

/**
 * The line height every Tamil display heading gets. The rule for
 * html:lang(ta) .font-display in styles/globals.css sets the same 1.25 and wins
 * over any leading class, so this class only keeps the markup saying what the
 * page shows.
 */
export const TAMIL_HEADING_LEADING = "leading-[1.25]";

/**
 * Which line height a heading gets, by script.
 *
 * Tamil letters carry marks above and below the line, so the tight leading the
 * display face wants in Latin makes two lines touch. Tamil used to take its own
 * number per heading from the second argument; it now takes the one number
 * above, and the second argument is no longer read.
 */
export const useHeadingLeading: (latin: string, tamil: string) => string = (latin) =>
  useLocale() === "ta" ? TAMIL_HEADING_LEADING : latin;
