"use client";

import { usePrivy, useWallets } from "@privy-io/react-auth";
import dynamic from "next/dynamic";
import { useEffect, useMemo } from "react";
import type { Hex } from "viem";
import { accountName, type SignedInUser } from "@/lib/studio/account";
import { useWalletState } from "@/lib/studio/binding";
import { MineNoAccount, MineWaiting } from "./MineFrame";
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
  const { ready, authenticated, user, login, logout } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();

  // The account Privy made for this person. A wallet they connected themselves
  // is not what registered anything here.
  const wallet = useMemo(
    () => wallets.find((entry) => entry.walletClientType === "privy")?.address as Hex | undefined,
    [wallets],
  );
  const account = useWalletState(authenticated, walletsReady, wallet !== undefined);

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
  if (account === "missing") {
    return <MineNoAccount onSignOut={logout} />;
  }
  if (wallet === undefined) {
    return <MineWaiting />;
  }
  return <OwnPictures wallet={wallet} account={accountName(user as SignedInUser | null)} onSignOut={() => void logout()} />;
}
