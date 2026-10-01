"use client";

import { motion } from "framer-motion";
import { useTranslations } from "next-intl";
import { WarningMark } from "@/components/WarningMark";
import { unreadLine, type ClaimRefusal } from "@/lib/claims/refusal";
import { RefusalLine } from "./RefusalLine";

const EASE = [0.16, 1, 0.3, 1] as const;

/**
 * The strip My pictures keeps where "Waiting for you" would be when the list
 * could not be read at all. Quiet on purpose: the grid under it is the page,
 * and this only says the check did not happen and offers it again.
 */
export function ReadFailed({
  refusal,
  reading,
  onAgain,
  onSignIn,
}: {
  refusal: ClaimRefusal;
  /** True while the list is being read again, so the button rests until the answer is in. */
  reading: boolean;
  onAgain: () => void;
  onSignIn: () => void;
}) {
  const t = useTranslations("claims");
  const line = unreadLine(refusal);

  if (line === "none") {
    return null;
  }

  return (
    <motion.section
      data-claims="read-failed"
      data-claims-unread={line}
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: EASE }}
      className="mb-12 max-w-[56rem] border-y border-line py-4"
    >
      {line === "signIn" ? (
        <RefusalLine refusal={refusal} onSignIn={onSignIn} />
      ) : (
        <div role="status" className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <p className="flex min-w-0 max-w-[60ch] items-start gap-2.5 text-base leading-relaxed text-text-muted">
            <WarningMark className="mt-[5px] shrink-0 text-text-faint" />
            <span className="min-w-0">{t("readFailed")}</span>
          </p>
          <button
            type="button"
            data-claims-read-again
            disabled={reading}
            onClick={onAgain}
            className="tap shrink-0 rounded-[8px] border border-line-strong px-4 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-text transition-colors duration-200 hover:border-accent hover:text-accent disabled:opacity-50"
          >
            {t("next.again")}
          </button>
        </div>
      )}
    </motion.section>
  );
}
