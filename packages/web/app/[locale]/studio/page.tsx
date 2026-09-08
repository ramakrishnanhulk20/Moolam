"use client";

import { usePrivy, useWallets } from "@privy-io/react-auth";
import { motion } from "framer-motion";
import { useTranslations } from "next-intl";
import { formatEther } from "viem";
import { useBalance } from "wagmi";
import { isPrivyConfigured } from "@/lib/env";

/**
 * The studio is where a creator's wallet lives. This build proves the three
 * things the rest of the flow stands on: login, an embedded wallet created
 * without a seed phrase, and one live read from Monad.
 */
export default function StudioPage() {
  const t = useTranslations("studio");

  return (
    <div className="mx-auto w-full max-w-[1400px] px-5 py-16 sm:px-8 sm:py-24">
      <motion.header
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
        className="max-w-[46ch]"
      >
        <h1 className="font-display text-[clamp(2.5rem,7vw,5rem)] uppercase leading-[0.9] tracking-[-0.01em]">
          {t("title")}
        </h1>
        <p className="mt-5 text-base leading-relaxed text-text-muted">{t("lede")}</p>
      </motion.header>

      <div className="mt-12 max-w-[52ch]">
        {isPrivyConfigured ? <Wallet /> : <p className="text-sm text-failed">{t("notConfigured")}</p>}
      </div>
    </div>
  );
}

function Wallet() {
  const t = useTranslations("studio");
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const embedded = wallets.find((wallet) => wallet.walletClientType === "privy") ?? wallets[0];
  const address = embedded?.address as `0x${string}` | undefined;
  const balance = useBalance({ address, query: { enabled: address !== undefined } });

  if (!ready) {
    return <p className="text-sm text-text-muted">{t("connecting")}</p>;
  }

  if (!authenticated) {
    return (
      <div className="space-y-5">
        <p className="text-sm text-text-muted">{t("loggedOut")}</p>
        <button
          type="button"
          onClick={login}
          className="rounded-[8px] bg-accent px-6 py-3 text-sm font-semibold uppercase tracking-[0.14em] text-accent-ink transition-transform duration-200 hover:-translate-y-0.5"
        >
          {t("login")}
        </button>
      </div>
    );
  }

  if (address === undefined) {
    return (
      <div className="space-y-5">
        <p className="text-sm text-text-muted">{t("noWallet")}</p>
        <LogoutButton onClick={logout} label={t("logout")} />
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      className="space-y-6 border border-line bg-bg-raised p-6"
    >
      <div>
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-text-faint">{t("wallet")}</p>
        <p className="mt-2 break-all font-mono text-sm text-text">{address}</p>
      </div>
      <div>
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-text-faint">{t("balance")}</p>
        {balance.isPending ? (
          <p className="mt-2 text-sm text-text-muted">{t("balancePending")}</p>
        ) : balance.isError ? (
          <p className="mt-2 text-sm text-failed">
            {t("balanceError", { reason: balance.error.message })}
          </p>
        ) : (
          <p className="mt-2 font-mono text-2xl text-accent">
            {Number(formatEther(balance.data.value)).toFixed(4)} {balance.data.symbol}
          </p>
        )}
      </div>
      <LogoutButton onClick={logout} label={t("logout")} />
    </motion.div>
  );
}

function LogoutButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-[8px] border border-line px-5 py-2.5 text-xs uppercase tracking-[0.18em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent"
    >
      {label}
    </button>
  );
}
