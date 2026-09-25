"use client";

import { useTranslations } from "next-intl";
import type { CSSProperties, ReactNode, RefObject } from "react";
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
 * on the bench in WO-124b.
 */
export function StudioBox({
  children,
  hold,
  top,
}: {
  children: ReactNode;
  hold?: RefObject<HTMLDivElement | null>;
  top?: number | null;
}) {
  return (
    <div
      ref={hold}
      data-studio-box
      className="mt-14 w-full max-w-[48rem] [overflow-anchor:none]"
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
 */
export function StudioWaiting() {
  const t = useTranslations("studio");

  return (
    <div className="relative" aria-busy="true">
      <div className="pointer-events-none select-none opacity-40">
        <SignedOut onSignIn={NOTHING} />
      </div>
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <WaitLabel text={t("opening")} />
      </div>
    </div>
  );
}

export function Notice({ text, tone = "muted" }: { text: string; tone?: "muted" | "failed" }) {
  return (
    <p className={`max-w-[54ch] text-sm leading-relaxed ${tone === "failed" ? "text-failed" : "text-text-muted"}`}>
      {text}
    </p>
  );
}
