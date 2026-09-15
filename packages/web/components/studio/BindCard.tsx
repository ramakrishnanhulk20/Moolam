"use client";

import { motion } from "framer-motion";
import { useTranslations } from "next-intl";
import type { Hex } from "viem";
import { MONAD_EXPLORER, shortHex } from "@/lib/chain/client";
import type { BindState } from "@/lib/studio/binding";
import { FailureNote } from "./FailureNote";
import { WaitLabel } from "./WaitLabel";
import { useHeadingLeading } from "./leading";

/**
 * The one setup step. A creator binds the unlock on this device to their
 * account, and from then on that unlock is the signature the registry checks.
 *
 * Rebinding is offered on the same card for anyone who lost the device, because
 * the contract allows it and hiding it would strand them.
 */
export function BindCard({
  state,
  rebind = false,
  wallet,
  confirming = false,
  onBind,
  onRecheck,
  onUnsponsored,
  onCancel,
}: {
  state: BindState;
  rebind?: boolean;
  /** Only for the fallback link, when a sponsored send landed without handing back a hash. */
  wallet?: Hex;
  confirming?: boolean;
  onBind: () => void;
  onRecheck?: () => void;
  /** Sends the same signed bind again, with the fee paid from the creator's own balance. */
  onUnsponsored?: () => void;
  /** Leaves the bind card without binding. Only offered when this was a choice, not the only way in. */
  onCancel?: () => void;
}) {
  const t = useTranslations("studio");
  const leading = useHeadingLeading("leading-[0.95]", "leading-[1.15]");
  // A bind that is out and unconfirmed keeps the button shut: a second passkey
  // would replace the key the first transaction is about to write.
  const busy =
    state.stage === "creating" ||
    state.stage === "waiting" ||
    state.stage === "sending" ||
    state.stage === "unconfirmed";

  return (
    <motion.section
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
      className="relative border border-line bg-bg-raised p-7 sm:p-10"
    >
      <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-accent">
        <span className="motif h-[9px] w-[9px]" />
        {t("bind.kicker")}
      </p>

      <h2 className={`mt-5 max-w-[20ch] font-display text-[clamp(1.7rem,3.4vw,2.7rem)] font-semibold uppercase tracking-[-0.02em] ${leading}`}>
        {rebind ? t("bind.headingAgain") : t("bind.heading")}
      </h2>
      <p className="mt-5 max-w-[56ch] text-base leading-relaxed text-text-muted">{t("bind.body")}</p>
      <p className="mt-3 max-w-[56ch] text-sm leading-relaxed text-text-faint">{t("bind.plain")}</p>

      {state.stage === "bound" ? (
        <div className="mt-8 border-s-2 border-verified ps-4">
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-verified">{t("bind.doneLabel")}</p>
          <p className="mt-2 max-w-[54ch] text-sm leading-relaxed text-text">{t("bind.doneBody")}</p>
          {state.txHash !== null ? (
            <a
              href={`${MONAD_EXPLORER}/tx/${state.txHash}`}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-block font-mono text-xs text-text-faint underline decoration-line underline-offset-4 transition-colors duration-200 hover:text-accent"
            >
              {t("bind.txLink", { hash: shortHex(state.txHash) })}
            </a>
          ) : wallet === undefined ? null : (
            <a
              href={`${MONAD_EXPLORER}/address/${wallet}`}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-block font-mono text-xs text-text-faint underline decoration-line underline-offset-4 transition-colors duration-200 hover:text-accent"
            >
              {t("bind.walletLink", { wallet: shortHex(wallet) })}
            </a>
          )}
        </div>
      ) : (
        <div className="mt-8 space-y-5">
          <div className="flex flex-wrap items-center gap-4">
            <button
              type="button"
              onClick={onBind}
              disabled={busy}
              className="rounded-[8px] bg-accent px-7 py-4 text-sm font-semibold uppercase tracking-[0.14em] text-accent-ink transition-transform duration-200 hover:-translate-y-0.5 disabled:translate-y-0 disabled:opacity-60"
            >
              {rebind ? t("bind.buttonAgain") : t("bind.button")}
            </button>
            {onCancel === undefined ? null : (
              <button
                type="button"
                onClick={onCancel}
                disabled={busy}
                className="rounded-[8px] border border-line px-5 py-3.5 text-xs uppercase tracking-[0.18em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent disabled:opacity-60"
              >
                {t("bind.notNow")}
              </button>
            )}
          </div>

          {state.stage === "creating" ? <WaitLabel text={t("bind.creating")} /> : null}
          {state.stage === "waiting" ? <WaitLabel text={t("bind.waiting")} /> : null}
          {state.stage === "sending" ? <WaitLabel text={confirming ? t("bind.confirming") : t("bind.sending")} /> : null}
        </div>
      )}

      {state.failure === null ? null : (
        <div className="mt-7">
          <FailureNote
            failure={state.failure}
            onAgain={onBind}
            onBind={onBind}
            onRecheck={onRecheck}
            onUnsponsored={onUnsponsored}
          />
        </div>
      )}
    </motion.section>
  );
}
