"use client";

import { useLocale } from "next-intl";

/**
 * Which line height a heading gets, by script.
 *
 * Tamil letters carry marks above and below the line, so the tight leading the
 * display face wants in Latin makes two lines touch. Every heading on this
 * screen asks for its own pair rather than one global number, because the
 * bigger the type, the more the two scripts disagree.
 */
export function useHeadingLeading(latin: string, tamil: string): string {
  return useLocale() === "ta" ? tamil : latin;
}
