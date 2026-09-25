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
