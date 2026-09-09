"use client";

import { motion } from "framer-motion";
import { useTranslations } from "next-intl";
import type { Hex } from "viem";
import { MONAD_EXPLORER, shortHex } from "@/lib/chain/client";
import type { Failure } from "@/lib/studio/problems";
import { Link } from "@/lib/i18n/routing";

/**
 * Every failure the studio can show, in the same shape: what went wrong in one
 * sentence, the service's or the browser's own words underneath, and the single
 * thing worth doing next.
 */
export function FailureNote({
  failure,
  passportId,
  onAgain,
  onSignIn,
  onBind,
  onUnsponsored,
  onRecheck,
}: {
  failure: Failure;
  passportId?: Hex | null;
  onAgain?: () => void;
  onSignIn?: () => void;
  onBind?: () => void;
  onUnsponsored?: () => void;
  onRecheck?: () => void;
}) {
  const t = useTranslations("studio");

  const handlers: Record<string, (() => void) | undefined> = {
    again: onAgain,
    signIn: onSignIn,
    bind: onBind,
    unsponsored: onUnsponsored,
    recheck: onRecheck,
  };
  const action = failure.next === undefined ? undefined : handlers[failure.next];

  // A send that is still out is not a send that failed, so it does not get the
  // red or the alert role. It waits in the muted ink, like the step above it.
  const pending = failure.key === "confirmPending";

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      role={pending ? "status" : "alert"}
      data-tone={pending ? "pending" : "failed"}
      className={`border-s-2 ps-4 py-3 ${pending ? "border-text-muted bg-text-muted/5" : "border-failed bg-failed/5"}`}
    >
      <p className={`max-w-[54ch] text-sm leading-relaxed ${pending ? "text-text-muted" : "text-failed"}`}>
        {t(`failure.${failure.key}`)}
      </p>
      {failure.reason === undefined ? null : (
        <p className="mt-2 max-w-[54ch] break-words font-mono text-[11px] leading-relaxed text-text-faint">
          {failure.reason}
        </p>
      )}

      {failure.address === undefined ? null : (
        <a
          href={`${MONAD_EXPLORER}/address/${failure.address}`}
          target="_blank"
          rel="noreferrer"
          className="mt-4 block font-mono text-[11px] text-text-faint underline decoration-line underline-offset-4 transition-colors duration-200 hover:text-accent"
        >
          {t("actions.openAddress", { wallet: shortHex(failure.address) })}
        </a>
      )}

      {failure.next === "openPassport" && passportId != null ? (
        <Link
          href={`/passport/${passportId}`}
          className="mt-4 inline-block rounded-[8px] border border-accent px-4 py-2 text-[11px] uppercase tracking-[0.18em] text-accent transition-transform duration-200 hover:-translate-y-0.5"
        >
          {t("actions.openPassport")}
        </Link>
      ) : null}

      {action === undefined ? null : (
        <button
          type="button"
          onClick={action}
          className="mt-4 rounded-[8px] border border-line px-4 py-2 text-[11px] uppercase tracking-[0.18em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent"
        >
          {t(`actions.${failure.next}`)}
        </button>
      )}
    </motion.div>
  );
}
