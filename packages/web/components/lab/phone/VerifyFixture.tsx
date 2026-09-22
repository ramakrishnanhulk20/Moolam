"use client";

import { useTranslations } from "next-intl";
import { VerifyScreen } from "@/components/verify/VerifyScreen";
import type { TrySample } from "@/lib/data/samples";

/**
 * The verify page: the words the route renders on the server, then the real
 * drop panel under them. The panel is the page's own component and the samples
 * are real records read off the index, so the primary action in this frame is
 * the one a visitor would press.
 */
export function VerifyFixture({ samples }: { samples: TrySample[] }) {
  const t = useTranslations("verify");

  return (
    <div className="relative mx-auto w-full max-w-[1400px] px-5 py-16">
      <header className="relative max-w-[54ch]">
        <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.28em] text-accent">
          <span className="motif h-[10px] w-[10px]" />
          {t("kicker")}
        </p>
        <h1 className="mt-6 max-w-[13ch] font-display text-[clamp(2.6rem,8.5vw,6.5rem)] font-semibold uppercase leading-[0.86] tracking-[-0.035em]">
          {t("title")}
        </h1>
        <p className="mt-7 max-w-[52ch] text-base leading-relaxed text-text-muted">{t("lede")}</p>
      </header>

      <VerifyScreen samples={samples} />
    </div>
  );
}
