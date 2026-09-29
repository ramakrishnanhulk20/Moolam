"use client";

import { PrivyProvider as Privy, type PrivyClientConfig } from "@privy-io/react-auth";
import { WagmiProvider, createConfig } from "@privy-io/wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useTheme } from "next-themes";
import { useState, type ReactNode } from "react";
import { http } from "wagmi";
import { monad } from "viem/chains";
import { isPrivyConfigured, publicEnv } from "@/lib/env";

/**
 * One wagmi config for the whole app, pointed at Monad mainnet only. It comes
 * from @privy-io/wagmi rather than wagmi itself, which is what keeps the
 * embedded wallet and wagmi's connector state in step.
 */
export const wagmiConfig = createConfig({
  chains: [monad],
  transports: { [monad.id]: http(publicEnv.monadRpcUrl) },
});

type SignInTheme = "light" | "dark";
type HexColor = `#${string}`;

/**
 * The sign-in window in Moolam's own palette for the theme in use. Privy takes a
 * hex for its theme and builds the rest of the window's greys from it, so the
 * ground is the site's raised card colour rather than Privy's navy. The accent
 * must follow the theme too: the dark pink sits almost invisible on the light
 * ground. The logo files carry their own width and height, because an SVG with
 * only a viewBox gives Privy's image no size and it collapses to nothing.
 */
const SIGN_IN_LOOK: Record<SignInTheme, { ground: HexColor; accent: HexColor; logo: string }> = {
  light: { ground: "#fbf9f5", accent: "#a92a48", logo: "/brand/seal-o/signin-mark-light.svg" },
  dark: { ground: "#101014", accent: "#ffb7c5", logo: "/brand/seal-o/signin-mark-dark.svg" },
};

export function signInAppearance(resolvedTheme: string | undefined): NonNullable<PrivyClientConfig["appearance"]> {
  const look = SIGN_IN_LOOK[resolvedTheme === "light" ? "light" : "dark"];
  return {
    theme: look.ground,
    accentColor: look.accent,
    walletChainType: "ethereum-only",
    landingHeader: "Moolam",
    logo: look.logo,
  };
}

/**
 * Login by email, Google or passkey, and a wallet is created for anyone who
 * arrives without one. Without an app id the tree renders untouched, so every
 * page that does not need a wallet still works and the studio explains what is
 * missing.
 */
export function PrivyProvider({ children }: { children: ReactNode }) {
  const { resolvedTheme } = useTheme();
  const [queryClient] = useState(() => new QueryClient());

  if (!isPrivyConfigured || publicEnv.privyAppId === undefined) {
    return children;
  }

  return (
    <Privy
      appId={publicEnv.privyAppId}
      config={{
        loginMethods: ["email", "google", "passkey"],
        embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } },
        defaultChain: monad,
        supportedChains: [monad],
        // Nobody signs in with an external wallet here, but Privy still sets up
        // its Coinbase connector, and the smart wallet half of it only knows a
        // handful of chains. Left alone it prints "The configured chains are not
        // supported by Coinbase Smart Wallet: 143" on every page load, which
        // tells a Monad reviewer their own chain is unsupported. Asking for the
        // plain wallet skips that whole path.
        externalWallets: { coinbaseWallet: { config: { preference: { options: "eoaOnly" } } } },
        appearance: signInAppearance(resolvedTheme),
      }}
    >
      <QueryClientProvider client={queryClient}>
        <WagmiProvider config={wagmiConfig}>{children}</WagmiProvider>
      </QueryClientProvider>
    </Privy>
  );
}
