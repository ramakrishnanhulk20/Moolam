"use client";

import { useTranslations } from "next-intl";
import { WarningMark } from "@/components/WarningMark";

/**
 * The line under an empty title field after a press, which the field names as
 * its own description so a screen reader hears it on the field.
 */
export function TitleNeeded({ id, className = "" }: { id: string; className?: string }) {
  const t = useTranslations("studio");

  return (
    <p
      id={id}
      role="alert"
      data-title-needed
      className={`mt-2 flex items-start gap-2 text-base leading-relaxed text-failed ${className}`.trim()}
    >
      <WarningMark className="mt-[5px]" />
      <span>{t("titleNeeded")}</span>
    </p>
  );
}

/** The title field's border: the failed red while it is the reason a press was refused. */
export function titleBorder(wanted: boolean): string {
  return wanted ? "border-failed focus:border-failed" : "border-line focus:border-accent";
}
