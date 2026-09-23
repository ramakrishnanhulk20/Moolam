"use client";

import { usePrivy, useWallets } from "@privy-io/react-auth";
import { MotionConfig } from "framer-motion";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import type { Hex } from "viem";
import { useWalletMounted } from "@/components/providers/WalletProvider";
import { WaitLabel } from "@/components/studio/WaitLabel";
import { YourPassports } from "@/components/studio/YourPassports";
import { isPrivyConfigured } from "@/lib/env";
import { useCreatorPassports, type CreatorPassports } from "@/lib/studio/useCreatorPassports";
import { SignInCard } from "./SignInCard";

/**
 * A person's own pictures, one tap from the bar on every page.
 *
 * Nothing here is remembered from a session: the grid is the index's answer to
 * "what has this address registered", which is why the same account shows the
 * same pictures on a laptop it has never opened Moolam on before.
 *
 * The hook that reads Privy only mounts once the SDK's provider is really above
 * this screen, the way the studio does it. Called any earlier, Privy's hooks
 * warn on every render and answer ready false, so the page paints its waiting
 * state from here instead.
 */
export function MineScreen() {
  const mounted = useWalletMounted();
  const studio = useTranslations("studio");

  return (
    <MotionConfig reducedMotion="user">
      {!isPrivyConfigured ? (
        <Notice text={studio("notConfigured")} tone="failed" />
      ) : mounted ? (
        <Pictures />
      ) : (
        <Waiting />
      )}
    </MotionConfig>
  );
}

/**
 * The card a signed out visitor is about to read, dimmed and inert until the
 * wallet lands. Same card, same height: nothing under it moves when the real
 * one takes its place.
 */
function Waiting() {
  const t = useTranslations("mine");

  return (
    <div className="relative" aria-busy="true">
      <div className="pointer-events-none select-none opacity-40">
        <SignInCard onSignIn={() => undefined} />
      </div>
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <WaitLabel text={t("opening")} />
      </div>
    </div>
  );
}

function Pictures() {
  const { ready, authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const t = useTranslations("studio");
  const grid = useTranslations("mine")("grid");

  // The account Privy made for this person. A wallet they connected themselves
  // is not what registered anything here.
  const wallet = useMemo(
    () => wallets.find((entry) => entry.walletClientType === "privy")?.address as Hex | undefined,
    [wallets],
  );
  const passports = useCreatorPassports(wallet);

  if (!ready) {
    return <Waiting />;
  }
  if (!authenticated) {
    return <SignInCard onSignIn={login} />;
  }
  if (wallet === undefined) {
    return <Notice text={t("noWallet")} />;
  }
  return (
    <>
      <YourPassports passports={passports} heading={grid} />
      <LoadMore passports={passports} />
    </>
  );
}

/**
 * The press that reads the next page of this account's pictures.
 *
 * It says it is working on its own face, and a page that would not come back
 * is reported on the same line, with the rows already read left where they are.
 * The words are the Explore grid's, because it is the same press over the same
 * index.
 */
function LoadMore({ passports }: { passports: CreatorPassports }) {
  const t = useTranslations("explore");

  if (passports.status !== "ready" || !passports.hasMore) {
    return null;
  }

  return (
    <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-4">
      <button
        type="button"
        onClick={passports.more}
        disabled={passports.loadingMore}
        aria-busy={passports.loadingMore}
        className="rounded-[8px] border border-line-strong px-6 py-3 font-mono text-[11px] uppercase tracking-[0.2em] text-text transition-colors duration-200 hover:border-accent hover:text-accent disabled:cursor-wait disabled:text-text-faint"
      >
        {passports.loadingMore ? t("loading") : t("loadMore")}
      </button>
      {passports.moreError === null ? null : (
        <p role="alert" className="max-w-[54ch] text-sm leading-relaxed text-failed">
          {t("error", { reason: passports.moreError })}
        </p>
      )}
    </div>
  );
}

function Notice({ text, tone = "muted" }: { text: string; tone?: "muted" | "failed" }) {
  return (
    <p className={`mt-16 max-w-[54ch] text-sm leading-relaxed ${tone === "failed" ? "text-failed" : "text-text-muted"}`}>
      {text}
    </p>
  );
}
