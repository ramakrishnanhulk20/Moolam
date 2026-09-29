"use client";

import { useTranslations } from "next-intl";
import { WarningMark } from "@/components/WarningMark";
import type { CSSProperties, ReactNode, RefObject } from "react";
import { useWide } from "./layout";
import { SignedOut } from "./SignedOut";
import { WaitLabel } from "./WaitLabel";

const NOTHING = () => undefined;

/**
 * The one box the whole studio lives in.
 *
 * The panel and the stub used to be two columns at lg, which put the answer to a
 * press below the fold of a laptop screen and beside it on a phone. They are one
 * column at every width now, off centre under the title rather than stretched
 * across the page, so the press, the run and the receipt read downwards as one
 * thing.
 *
 * Scroll anchoring is off inside it: a press folds a long form away, and the
 * browser answers that by putting the scroll back where the folded content used
 * to hold it, which undoes the one scroll that brings the run into view. Proved
 * in a real browser.
 *
 * Under the wide layout the box lets go of its cap at lg, but only once the
 * panel is the card on screen: the sign in, the bind and the recovery cards are
 * single cards and read best at today's width.
 */
export function StudioBox({
  children,
  hold,
  top,
  fill = false,
}: {
  children: ReactNode;
  hold?: RefObject<HTMLDivElement | null>;
  top?: number | null;
  /** True when the register or generate panel is on screen, the one card the wide layout spreads out. */
  fill?: boolean;
}) {
  const wide = useWide() && fill;

  return (
    <div
      ref={hold}
      data-studio-box
      data-studio-layout={wide ? "wide" : undefined}
      className={`w-full max-w-[48rem]${wide ? " lg:max-w-none" : ""} [overflow-anchor:none]`}
      style={top === null || top === undefined ? undefined : ({ "--studio-top": `${top}px` } as CSSProperties)}
    >
      {children}
    </div>
  );
}

/**
 * The same card a cold visitor is about to read, dimmed and inert until the
 * wallet lands.
 *
 * A one line wait label here instead measured 0.296 of layout shift on a
 * phone: the card dropped in at 889 px tall and shoved the receipt and the
 * footer off the screen. Same card, same height, nothing under it moves.
 *
 * The same card carries every wait between the sign in and the first real
 * card: the account opening, then the passkey read. Only the label changes.
 */
export function StudioWaiting({ text }: { text?: string }) {
  const t = useTranslations("studio");

  return (
    <div className="relative" aria-busy="true">
      <div className="pointer-events-none select-none opacity-40">
        <SignedOut onSignIn={NOTHING} />
      </div>
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <WaitLabel text={text ?? t("opening")} />
      </div>
    </div>
  );
}

/** Signed in, and Privy never made the account. Signing out and in again is the way on, so the button is right here. */
export function NoAccount({ onSignOut }: { onSignOut: () => void }) {
  const t = useTranslations("studio");

  return (
    <div>
      <Notice text={t("noWallet")} />
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

export function Notice({ text, tone = "muted" }: { text: string; tone?: "muted" | "failed" }) {
  return (
    <p
      role={tone === "failed" ? "alert" : undefined}
      className={`flex max-w-[54ch] items-start gap-2.5 text-sm leading-relaxed ${tone === "failed" ? "text-failed" : "text-text-muted"}`}
    >
      {tone === "failed" ? <WarningMark className="mt-[3px]" /> : null}
      <span className="min-w-0">{text}</span>
    </p>
  );
}
