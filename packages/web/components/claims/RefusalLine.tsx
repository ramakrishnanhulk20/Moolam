"use client";

import { useTranslations } from "next-intl";
import { WarningMark } from "@/components/WarningMark";
import type { ClaimRefusal } from "@/lib/claims/refusal";

/** A refused call in plain words, with the one button that is worth pressing next. */
export function RefusalLine({
  refusal,
  onAgain,
  onSignIn,
  onReload,
  className = "",
}: {
  refusal: ClaimRefusal;
  onAgain?: () => void;
  onSignIn?: () => void;
  onReload?: () => void;
  className?: string;
}) {
  const t = useTranslations("claims");
  const press = refusal.next === "again" ? onAgain : refusal.next === "signIn" ? onSignIn : refusal.next === "reload" ? onReload : undefined;

  return (
    <div role="alert" data-claims-refusal={refusal.key} className={`flex flex-wrap items-center gap-x-5 gap-y-3 ${className}`}>
      <p className="flex max-w-[60ch] items-start gap-2.5 text-base leading-relaxed text-failed">
        <WarningMark className="mt-[5px] shrink-0" />
        <span className="min-w-0">{t(`refusal.${refusal.key}`)}</span>
      </p>
      {press === undefined || refusal.next === undefined ? null : (
        <button
          type="button"
          onClick={press}
          className="tap rounded-[8px] border border-line-strong px-4 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-text transition-colors duration-200 hover:border-accent hover:text-accent"
        >
          {t(`next.${refusal.next}`)}
        </button>
      )}
    </div>
  );
}
