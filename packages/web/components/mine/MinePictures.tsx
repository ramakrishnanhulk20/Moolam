"use client";

import { usePrivy, useWallets } from "@privy-io/react-auth";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { useEffect, useMemo } from "react";
import type { Hex } from "viem";
import { MineNotice, MineWaiting } from "./MineFrame";
import { SignInCard } from "./SignInCard";

const loadOwn = () => import("./OwnPictures").then((module) => module.OwnPictures);

// The grid, its index reads and the passport list code only exist for an
// account that has signed in, so a visitor who never does never downloads them.
const OwnPictures = dynamic(loadOwn);

/**
 * The page once the wallet SDK is above it: who is signed in, and which
 * account's pictures to read. MineScreen loads this file once Privy's provider
 * is mounted, and not before.
 */
export function MinePictures() {
  const { ready, authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const t = useTranslations("studio");

  // The account Privy made for this person. A wallet they connected themselves
  // is not what registered anything here.
  const wallet = useMemo(
    () => wallets.find((entry) => entry.walletClientType === "privy")?.address as Hex | undefined,
    [wallets],
  );

  useEffect(() => {
    if (authenticated) {
      void loadOwn();
    }
  }, [authenticated]);

  if (!ready) {
    return <MineWaiting />;
  }
  if (!authenticated) {
    return <SignInCard onSignIn={login} />;
  }
  if (wallet === undefined) {
    return <MineNotice text={t("noWallet")} />;
  }
  return <OwnPictures wallet={wallet} />;
}
