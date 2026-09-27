"use client";

import { useTranslations } from "next-intl";

/**
 * The service matched against a copy of the register that has not refreshed for a while, so a
 * picture registered since may be missing from it: "not this picture" or "a different record" from
 * an old copy may only mean a registration it has not seen yet. Said once, quietly, under the
 * verdict it qualifies, and only when the service itself called the copy stale.
 *
 * One line for every screen that shows a verify answer (the verify card, the passport page's
 * check, the story's try panel), so a reader is told the same thing wherever they dropped a copy.
 */
export function StaleIndex({ minutes, className = "mt-3" }: { minutes: number | undefined; className?: string }) {
  const t = useTranslations("verify");
  if (minutes === undefined) {
    return null;
  }
  return (
    <p data-stale-index className={`${className} max-w-[44ch] text-xs leading-relaxed text-text-faint`}>
      {t("staleIndex", { minutes })}
    </p>
  );
}
