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
 * The mark SessionMark writes on a device that has signed in to Moolam, and
 * the only thing a "returning" page looks at before it fetches the SDK.
 */
export const RETURNING_KEY = "moolam:wallet:returning";

/** Whether this browser has signed in here before. A browser that refuses storage counts as new. */
function signedInBefore(): boolean {
  try {
    return window.localStorage.getItem(RETURNING_KEY) === "1";
  } catch {
    return false;
  }
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
 *
 * load says who gets the SDK. "always" is the studio and the resolve console,
 * where signing in is the point of the page. "returning" is a passport, where
 * the two writing panels show nothing to a signed out visitor: a reader who has
 * never signed in on this device pays nothing for panels they cannot see, and a
 * creator who has gets them as before. The check runs inside the effect, never
 * during render, so the server and the first client paint stay identical on
 * every device.
 */
export function WalletProvider({ children, load = "always" }: { children: ReactNode; load?: "always" | "returning" }) {
  const [privy, setPrivy] = useState<{ Provider: Wrapper; Mark: ComponentType } | null>(null);

  useEffect(() => {
    if (!isPrivyConfigured || (load === "returning" && !signedInBefore())) {
      return;
    }

    let live = true;
    // Both halves come down the same dynamic path. SessionMark imports the SDK
    // directly, so naming it anywhere a bundler reads statically would put the
    // wallet back into the page's own scripts.
    void Promise.all([import("./PrivyProvider"), import("./SessionMark")]).then(([provider, mark]) => {
      if (live) {
        setPrivy({ Provider: provider.PrivyProvider, Mark: mark.SessionMark });
      }
    });

    return () => {
      live = false;
    };
  }, [load]);

  if (privy === null) {
    return children;
  }

  const Provider = privy.Provider;
  const Mark = privy.Mark;
  return (
    <Provider>
      <Mark />
      <WalletMounted.Provider value={true}>{children}</WalletMounted.Provider>
    </Provider>
  );
}
