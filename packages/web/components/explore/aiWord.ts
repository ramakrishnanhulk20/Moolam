"use client";

import { useTranslations } from "next-intl";
import type { ExploreAi } from "./query";

/**
 * The word for one AI-use answer, including the way back to any answer at all.
 *
 * Two of the four words are read straight out of the passport page's own
 * vocabulary, so a picture called "Not for AI training" there can never be
 * called something else on Explore. The chips, the chip that opens them and the
 * empty sheet all name an answer through this one function.
 */
export function useAiWord(): (ai: ExploreAi | null) => string {
  const t = useTranslations("explore");
  const said = useTranslations("passport.consent.summary");
  return (ai) => (ai === null ? t("ai.any") : ai === "ask" || ai === "none" ? t(`ai.${ai}`) : said(ai));
}
