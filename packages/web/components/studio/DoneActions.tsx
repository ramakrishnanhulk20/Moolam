"use client";

import { useTranslations } from "next-intl";
import { useId } from "react";
import type { Hex } from "viem";
import { MONAD_EXPLORER, gatewayUrl, shortHex } from "@/lib/chain/client";
import { HEX_MARK, withHex } from "@/components/agents/hex";
import { Link } from "@/lib/i18n/routing";
import { holdsUnsavedFile, isStating, passportId, type RegisterState } from "@/lib/studio/flow";

/**
 * The end of the box: where this picture went, and the way back to a clean form.
 *
 * Both paths end here rather than each keeping its own row, because what a
 * creator can do with a finished passport does not depend on who drew it. Only
 * the agent's own record is path specific.
 *
 * Make another refuses while the one copy of a sealed picture is still in this
 * tab and nowhere else: a new run clears the file out of the state, and that
 * would be the only copy gone. It refuses again while a statement is out from
 * the same wallet, because a new run would take the screen off a write Monad has
 * not shown yet.
 */
export function DoneActions({
  state,
  wallet,
  onReset,
}: {
  state: RegisterState;
  /** Only for the fallback link, when a sponsored send landed without handing back a hash. */
  wallet?: Hex;
  onReset: () => void;
}) {
  const t = useTranslations("studio");
  const agent = useTranslations("studio.generate");
  const id = passportId(state);
  const prepared = state.prepared;
  const published = prepared !== null && prepared.sealed !== true;
  const drawn = state.generated;
  const holding = holdsUnsavedFile(state);
  const stating = isStating(state);
  const holdId = useId();
  const stateId = useId();

  return (
    <div className="mt-8" data-done-actions>
      <div className="flex flex-wrap items-center gap-3">
        {id === null ? null : (
          <Link
            href={`/passport/${id}`}
            className="rounded-[8px] bg-accent px-6 py-3.5 text-xs font-semibold uppercase tracking-[0.16em] text-accent-ink transition-transform duration-200 hover:-translate-y-0.5"
          >
            {t("register.openPassport")}
          </Link>
        )}

        {state.mode === "generate" && drawn !== null ? (
          <Link
            href={`/agent/${drawn.agent.id}`}
            className="rounded-[8px] border border-line px-5 py-3.5 text-xs uppercase tracking-[0.16em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent"
          >
            {agent("openAgent")}
          </Link>
        ) : null}

        {state.txHash !== null ? (
          <a
            href={`${MONAD_EXPLORER}/tx/${state.txHash}`}
            target="_blank"
            rel="noreferrer"
            className="rounded-[8px] border border-line px-5 py-3.5 text-xs uppercase tracking-[0.16em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent"
          >
            {withHex(t("register.openTx", { hash: HEX_MARK }), shortHex(state.txHash))}
          </a>
        ) : wallet === undefined ? null : (
          <a
            href={`${MONAD_EXPLORER}/address/${wallet}`}
            target="_blank"
            rel="noreferrer"
            className="rounded-[8px] border border-line px-5 py-3.5 text-xs uppercase tracking-[0.16em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent"
          >
            {withHex(t("register.openAddress", { wallet: HEX_MARK }), shortHex(wallet))}
          </a>
        )}

        {!published || prepared === null ? null : (
          <a
            href={gatewayUrl(prepared.image.uri)}
            target="_blank"
            rel="noreferrer"
            className="rounded-[8px] border border-line px-5 py-3.5 text-xs uppercase tracking-[0.16em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent"
          >
            {t("register.openImage")}
          </a>
        )}

        <button
          type="button"
          onClick={onReset}
          disabled={stating || holding}
          aria-describedby={waitIds(holding, stating, holdId, stateId)}
          data-again
          className="rounded-[8px] border border-line px-5 py-3.5 text-xs uppercase tracking-[0.16em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent disabled:opacity-50"
        >
          {state.mode === "generate" ? agent("another") : t("register.another")}
        </button>
      </div>

      {holding ? (
        <p id={holdId} className="mt-3.5 max-w-[46ch] text-base leading-relaxed text-text-faint">
          {t("sealed.handback.only")}
        </p>
      ) : null}
      {stating ? (
        <p id={stateId} data-another-waits className="mt-3.5 max-w-[46ch] text-base leading-relaxed text-text-faint">
          {t("register.anotherWaits")}
        </p>
      ) : null}
    </div>
  );
}

/** Every line that says why Register another is grey, for the button to name as its description. */
function waitIds(holding: boolean, stating: boolean, holdId: string, stateId: string): string | undefined {
  const ids = [holding ? holdId : null, stating ? stateId : null].filter((id) => id !== null);
  return ids.length === 0 ? undefined : ids.join(" ");
}
