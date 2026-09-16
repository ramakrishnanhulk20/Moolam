"use client";

import { motion } from "framer-motion";
import { useTranslations } from "next-intl";
import type { Hex } from "viem";
import { CHAIN_ID, MONAD_EXPLORER, shortHex } from "@/lib/chain/client";
import type { AccountName } from "@/lib/studio/account";
import type { Sponsorship } from "@/lib/studio/useStudio";
import { CopyButton } from "./CopyButton";

/**
 * Who is signed in, which account they are signing with, and who is paying the
 * network fee. The fee line is deliberately two different sentences: one before
 * a transaction has landed, one after, because only the second one is proved.
 *
 * The passkey sentence sits under it because the two answer the same question:
 * a creator here signs with their own device and pays nothing, and neither of
 * those was said anywhere on the screen before.
 */
export function IdentityStrip({
  account,
  wallet,
  sponsorship,
  passkey = false,
  onSignOut,
}: {
  account: AccountName;
  wallet: Hex;
  sponsorship: Sponsorship;
  /** True only when the key bound on chain is one this device can sign with. */
  passkey?: boolean;
  onSignOut: () => void;
}) {
  const t = useTranslations("studio");

  const fee =
    sponsorship === "proven" ? t("identity.gasProven") : sponsorship === "own" ? t("identity.gasOwn") : t("identity.gasClaimed");

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      className="flex flex-wrap items-start gap-x-10 gap-y-5 border-y border-line py-5"
    >
      <Field label={t("identity.account")}>
        <span className="break-all text-sm text-text">
          {account.value ?? t(`identity.kind${capitalise(account.kind)}`)}
        </span>
      </Field>

      <Field label={t("identity.wallet")}>
        <span className="flex items-center gap-2">
          <a
            href={`${MONAD_EXPLORER}/address/${wallet}`}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-sm text-text transition-colors duration-200 hover:text-accent"
          >
            {shortHex(wallet)}
          </a>
          <CopyButton value={wallet} />
        </span>
      </Field>

      <Field label={t("identity.network")}>
        <span className="font-mono text-sm text-text">{t("identity.monad", { chainId: CHAIN_ID })}</span>
      </Field>

      <Field label={t("identity.gas")}>
        <span className="flex flex-col gap-1.5">
          <span className={`text-sm ${sponsorship === "proven" ? "text-verified" : "text-text"}`}>{fee}</span>
          {passkey ? (
            <span className="flex items-center gap-2 text-xs leading-relaxed text-verified">
              <span aria-hidden className="h-[6px] w-[6px] shrink-0 bg-verified" />
              {t("identity.passkeySigned")}
            </span>
          ) : null}
        </span>
      </Field>

      <button
        type="button"
        onClick={onSignOut}
        className="ms-auto self-center rounded-[8px] border border-line px-4 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-text-faint transition-colors duration-200 hover:border-accent hover:text-accent"
      >
        {t("signOut")}
      </button>
    </motion.div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{label}</p>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

function capitalise(value: string): string {
  return `${value[0].toUpperCase()}${value.slice(1)}`;
}
