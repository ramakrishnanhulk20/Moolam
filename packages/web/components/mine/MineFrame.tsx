"use client";

import { useTranslations } from "next-intl";
import { WaitLabel } from "@/components/studio/WaitLabel";
import { SignInCard } from "./SignInCard";

const NOTHING = () => undefined;

/**
 * The card a signed out visitor is about to read, dimmed and inert until the
 * wallet lands. Same card, same height: nothing under it moves when the real
 * one takes its place.
 */
export function MineWaiting() {
  const t = useTranslations("mine");

  return (
    <div className="relative" aria-busy="true">
      <div className="pointer-events-none select-none opacity-40">
        <SignInCard onSignIn={NOTHING} />
      </div>
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <WaitLabel text={t("opening")} />
      </div>
    </div>
  );
}

export function MineNotice({ text, tone = "muted" }: { text: string; tone?: "muted" | "failed" }) {
  return (
    <p className={`mt-16 max-w-[54ch] text-sm leading-relaxed ${tone === "failed" ? "text-failed" : "text-text-muted"}`}>
      {text}
    </p>
  );
}

/** Signed in, and Privy never made the account. Signing out and in again is the way on, so the button is right here. */
export function MineNoAccount({ onSignOut }: { onSignOut: () => void }) {
  const t = useTranslations("studio");

  return (
    <div className="mt-16">
      <p className="max-w-[54ch] text-sm leading-relaxed text-text-muted">{t("noWallet")}</p>
      <button
        type="button"
        onClick={onSignOut}
        className="mt-5 rounded-[8px] border border-line px-5 py-3 text-[11px] uppercase tracking-[0.18em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent"
      >
        {t("signOut")}
      </button>
    </div>
  );
}
