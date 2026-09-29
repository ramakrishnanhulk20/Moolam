"use client";

import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

/**
 * The stub's paper: the torn top edge with a notch punched at each end, its
 * heading and the line under it. Receipt.tsx fills it with what a run has
 * established.
 *
 * It lives apart from the receipt so the page a signed out visitor opens can
 * draw the empty stub without the receipt's own code, which reads the chain,
 * formats fees and writes sealed files. Both paths draw this one component, so
 * the empty stub and the real one cannot drift apart.
 */
export function ReceiptFrame({ children }: { children: ReactNode }) {
  const t = useTranslations("studio");

  return (
    /* The stub is part of the one box now, so its tear is a horizontal line
       across the top of it with a notch punched at each end, rather than the
       vertical rule it used to hang off beside a second column. */
    <aside data-studio-receipt className="relative mt-10 border-t border-dashed border-line-strong pt-10">
      <span
        aria-hidden
        className="pointer-events-none absolute -top-3 -start-3 h-6 w-6 rounded-full border border-line bg-bg"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute -top-3 -end-3 h-6 w-6 rounded-full border border-line bg-bg"
      />

      <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-text-faint">{t("receipt.heading")}</p>
      <p className="mt-3 max-w-[40ch] text-base leading-relaxed text-text-muted">{t("receipt.body")}</p>

      {children}
    </aside>
  );
}

/** The line a stub with nothing stamped on it says. */
export function EmptyStamps() {
  const t = useTranslations("studio");
  return <p className="mt-8 max-w-[36ch] text-base leading-relaxed text-text-faint">{t("receipt.empty")}</p>;
}

/** The stub before anyone has signed in: nothing has been done in anyone's name yet. */
export function EmptyReceipt() {
  return (
    <ReceiptFrame>
      <EmptyStamps />
    </ReceiptFrame>
  );
}
