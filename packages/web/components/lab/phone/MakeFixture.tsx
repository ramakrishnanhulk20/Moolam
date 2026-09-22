"use client";

import { useTranslations } from "next-intl";
import { SignedOut } from "@/components/studio/SignedOut";

/**
 * The studio as a visitor who has never signed in sees it. The card is the
 * page's own component; only the heading above it is rebuilt here, because the
 * studio's own shell sits inside the wallet provider and the bench carries no
 * wallet.
 *
 * Nothing is wired: the button is there to be measured against the bar, not
 * pressed.
 */
export function MakeFixture() {
  const t = useTranslations("studio");

  return (
    <div className="mx-auto w-full max-w-[1400px] px-5 py-16">
      <header className="relative">
        <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.28em] text-accent">
          <span className="motif h-[10px] w-[10px]" />
          {t("kicker")}
        </p>
        <h1 className="mt-6 max-w-[14ch] font-display text-[clamp(2.6rem,8.5vw,6.5rem)] font-semibold uppercase leading-[0.86] tracking-[-0.035em]">
          {t("title")}
        </h1>
        <p className="mt-7 max-w-[52ch] text-base leading-relaxed text-text-muted">{t("lede")}</p>
      </header>

      <div className="mt-14">
        <SignedOut onSignIn={() => undefined} />
      </div>
    </div>
  );
}
