"use client";

import { createContext, useContext, useEffect, useState, type ComponentType, type ReactNode } from "react";
import { isPrivyConfigured } from "@/lib/env";

type Wrapper = ComponentType<{ children: ReactNode }>;

/**
 * Whether the wallet SDK's own provider is above this point in the tree.
 *
 * Exported so a test can put a screen under a mounted wallet without a
 * browser. Nothing else should set it: WalletProvider is the only place that
 * knows when the SDK has actually arrived.
 */
export const WalletMounted = createContext(false);

/** True only while Privy's provider is mounted, so a screen knows its hooks are safe to call. */
export function useWalletMounted(): boolean {
  return useContext(WalletMounted);
}

/**
 * The wallet, mounted on the three routes that sign and nowhere else.
 *
 * Privy brings wagmi, viem and the noble libraries with it, about half a
 * megabyte that a reader of the home page, the docs or an agent will never
 * use, so the provider is no longer in the layout every route shares. It is
 * asked for here, by the pages that need it.
 *
 * The children render before it arrives and again once it is up, because the
 * passport page passes server rendered content through here. Privy's hooks do
 * not survive that first pass: called without their context they print a
 * warning on every render and answer ready false. So the screens under this
 * provider read useWalletMounted and paint their waiting state until it is
 * true, and only then call a hook. Without an app id nothing is fetched at all.
 */
export function WalletProvider({ children }: { children: ReactNode }) {
  const [privy, setPrivy] = useState<{ Provider: Wrapper } | null>(null);

  useEffect(() => {
    if (!isPrivyConfigured) {
      return;
    }

    let live = true;
    void import("./PrivyProvider").then((loaded) => {
      if (live) {
        setPrivy({ Provider: loaded.PrivyProvider });
      }
    });

    return () => {
      live = false;
    };
  }, []);

  if (privy === null) {
    return children;
  }

  const Provider = privy.Provider;
  return (
    <Provider>
      <WalletMounted.Provider value={true}>{children}</WalletMounted.Provider>
    </Provider>
  );
}
