"use client";

import { usePrivy, useWallets } from "@privy-io/react-auth";
import { useMemo } from "react";
import { getAddress } from "viem";
import type { OriginAsker } from "@/lib/data/platform-label";
import { ConnectPanel } from "./ConnectPanel";

/**
 * The signed-in half of the connect page. The address shown, and the only one
 * that can be shared, is the account's own embedded wallet: the one Privy made
 * at sign-up and the one every Moolam page signs from.
 */
export function ConnectLive({ asker }: { asker: OriginAsker }) {
  const { ready, authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const wallet = useMemo(() => {
    const embedded = wallets.find((entry) => entry.walletClientType === "privy");
    return embedded === undefined ? null : getAddress(embedded.address);
  }, [wallets]);

  return (
    <ConnectPanel asker={asker} wallet={authenticated ? wallet : null} signedIn={ready ? authenticated : null} onSignIn={login} />
  );
}
