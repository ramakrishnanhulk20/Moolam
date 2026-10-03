"use client";

import { usePrivy } from "@privy-io/react-auth";
import { motion } from "framer-motion";
import { useTranslations } from "next-intl";
import type { Hex } from "viem";
import { WarningMark } from "@/components/WarningMark";
import { MONAD_EXPLORER, shortHex } from "@/lib/chain/client";
import { isPrivyConfigured } from "@/lib/env";
import { canPayOwnFee, type Failure } from "@/lib/studio/problems";
import { Link } from "@/lib/i18n/routing";
import { FailureDetails } from "./FailureDetails";

/**
 * Every failure the studio can show, in the same shape: what went wrong in one
 * translated sentence, the single thing worth doing next, and the service's or
 * the browser's own words folded away under Details.
 */
export function FailureNote({
  failure,
  passportId,
  onAgain,
  onGenerateAgain,
  onUpload,
  onEditPrompt,
  onSignIn,
  onBind,
  onUnsponsored,
  onRecheck,
  balance,
}: {
  failure: Failure;
  passportId?: Hex | null;
  onAgain?: () => void;
  /** The agent path's retry: it draws a new picture rather than resending the last one. */
  onGenerateAgain?: () => void;
  /** Leaves the agent path for the upload form, when the agent cannot draw or today's pictures are spent. */
  onUpload?: () => void;
  /** Brings the agent form back with the refused prompt in it. */
  onEditPrompt?: () => void;
  onSignIn?: () => void;
  onBind?: () => void;
  onUnsponsored?: () => void;
  onRecheck?: () => void;
  /** The account's own MON, read once a sponsored send was refused. Null until it is read. */
  balance?: bigint | null;
}) {
  const t = useTranslations("studio");

  const handlers: Record<string, (() => void) | undefined> = {
    again: onAgain,
    generateAgain: onGenerateAgain,
    openUpload: onUpload,
    editPrompt: onEditPrompt,
    signIn: onSignIn,
    bind: onBind,
    unsponsored: onUnsponsored,
    recheck: onRecheck,
  };
  // With nothing in the account, paying the fee itself would only be refused
  // again, so the offer steps aside for the line that says why.
  const unsponsored = failure.next === "unsponsored";
  const broke = unsponsored && !canPayOwnFee(balance);
  const action = failure.next === undefined || broke ? undefined : handlers[failure.next];

  // A send that is still out is not a send that failed, so it does not get the
  // red, the mark or the alert role. It waits in the muted ink, like the step
  // above it. Everything under a failed line starts where its words start.
  const pending = failure.key === "confirmPending";
  const indent = pending ? "" : "ms-[23px] ";

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      role={pending ? "status" : "alert"}
      data-tone={pending ? "pending" : "failed"}
      className={`border-s-2 ps-4 py-3 ${pending ? "border-text-muted bg-text-muted/5" : "border-failed bg-failed/5"}`}
    >
      <p
        className={`flex max-w-[54ch] items-start gap-2.5 text-base leading-relaxed ${pending ? "text-text-muted" : "text-failed"}`}
      >
        {pending ? null : <WarningMark className="mt-[5px]" />}
        <span className="min-w-0">{t(`failure.${failure.key}`)}</span>
      </p>

      {broke ? (
        <p data-balance-empty className={`${indent}mt-3 max-w-[54ch] text-base leading-relaxed text-text-muted`}>
          {t("register.balanceEmpty")}
        </p>
      ) : null}

      {failure.address === undefined ? null : (
        <a
          href={`${MONAD_EXPLORER}/address/${failure.address}`}
          target="_blank"
          rel="noreferrer"
          className={`${indent}mt-4 block font-mono text-[11px] text-text-faint underline decoration-line underline-offset-4 transition-colors duration-200 hover:text-accent`}
        >
          {t("actions.openAddress", { wallet: shortHex(failure.address) })}
        </a>
      )}

      {/* The refusal's own id wins: it names the passport that already holds this
          picture, and it is the only one there is when the duplicate was caught
          before anything was prepared. */}
      {failure.next === "openPassport" && (failure.passportId ?? passportId) != null ? (
        <Link
          href={`/passport/${failure.passportId ?? passportId}`}
          className="ms-[23px] mt-4 inline-block rounded-[8px] border border-accent px-4 py-2 text-[11px] uppercase tracking-[0.18em] text-accent transition-transform duration-200 hover:-translate-y-0.5"
        >
          {t("actions.openPassport")}
        </Link>
      ) : null}

      {/* Signing out is the studio's own account button, not a step of the
          register flow, so it is offered here rather than threaded through every
          card that can raise this failure. */}
      {failure.next === "signOut" && isPrivyConfigured ? <SignOutButton label={t("actions.signOut")} /> : null}

      {/* The balance sits beside the offer to spend it, so the creator reads
          what they hold before they press. */}
      {action === undefined ? null : (
        <div className={`${indent}mt-4 flex flex-wrap items-center gap-x-5 gap-y-2`}>
          <button
            type="button"
            onClick={action}
            className="rounded-[8px] border border-line px-4 py-2 text-[11px] uppercase tracking-[0.18em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent"
          >
            {t(`actions.${failure.next}`)}
          </button>
          {unsponsored && balance !== null && balance !== undefined ? (
            <p data-balance className="font-mono text-xs leading-relaxed text-text-faint">
              {t("register.balance", { mon: (Number(balance) / 1e18).toFixed(4) })}
            </p>
          ) : null}
        </div>
      )}

      {failure.reason === undefined ? null : (
        <FailureDetails reason={failure.reason} className={`${indent}mt-4`} />
      )}
    </motion.div>
  );
}

function SignOutButton({ label }: { label: string }) {
  const { logout } = usePrivy();

  return (
    <button
      type="button"
      onClick={() => void logout()}
      className="ms-[23px] mt-4 rounded-[8px] border border-line px-4 py-2 text-[11px] uppercase tracking-[0.18em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent"
    >
      {label}
    </button>
  );
}
