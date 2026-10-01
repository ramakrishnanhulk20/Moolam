"use client";

import type { ReactNode } from "react";
import type { Hex } from "viem";
import { useRouter } from "@/lib/i18n/routing";
import type { AnswerDispute } from "@/lib/disputes/answer";
import { useHolderAnswer } from "@/lib/disputes/useHolderAnswer";
import { refreshPassport } from "@/lib/passport/refresh";
import { AnswerForm } from "./AnswerForm";

/**
 * The form for the wallet that holds the passport, and what everybody else
 * sees in its place. In its own file so the wallet SDK reaches a page only
 * through HolderAnswer's dynamic import.
 */
export function HolderAnswerPanel({
  passportId,
  dispute,
  until,
  fallback,
}: {
  passportId: Hex;
  dispute: AnswerDispute;
  until: number;
  /** What a reader who is not the holder sees: the "not answered yet" line. */
  fallback: ReactNode;
}) {
  const router = useRouter();
  const answer = useHolderAnswer({
    passportId,
    dispute,
    // The page is held for a minute, so it is dropped before it reads itself
    // again; the answer then shows to everyone as the holder's words.
    onAnswered: () => {
      void refreshPassport(passportId).then(() => router.refresh());
    },
  });

  if (!answer.ready || !answer.isHolder) {
    return <>{fallback}</>;
  }
  return <AnswerForm answer={answer} until={until} />;
}
