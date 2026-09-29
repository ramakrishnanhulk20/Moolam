"use client";

import { useTranslations } from "next-intl";
import { reason as oneLine } from "@/lib/chain/client";

/**
 * The service's or the browser's own words under a failure, folded shut.
 *
 * They are English and technical whatever language the page is in, so the
 * translated sentence above stands alone and this is there only for someone who
 * opens it. Only the first line is kept, with every address taken out, because
 * a chain read's error carries the endpoint and the whole request.
 */
export function FailureDetails({ reason, className = "" }: { reason: string; className?: string }) {
  const common = useTranslations("common");

  return (
    <details data-failure-details className={`group max-w-[54ch] ${className}`.trim()}>
      <summary className="w-fit cursor-pointer list-none font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint transition-colors duration-200 hover:text-accent [&::-webkit-details-marker]:hidden">
        <span
          aria-hidden
          className="me-2 inline-block transition-transform duration-200 group-open:rotate-90 motion-reduce:transition-none"
        >
          {"›"}
        </span>
        {common("details")}
      </summary>
      <p lang="en" dir="ltr" className="mt-2 break-words font-mono text-[11px] leading-relaxed text-text-faint">
        {oneLine(reason)}
      </p>
    </details>
  );
}
