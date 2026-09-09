"use client";

import { PrivyProvider as Privy } from "@privy-io/react-auth";
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
        appearance: {
          theme: resolvedTheme === "light" ? "light" : "dark",
          accentColor: "#ffb7c5",
          walletChainType: "ethereum-only",
          landingHeader: "Moolam",
          logo: "/brand/seal-o/mark.svg",
        },
      }}
    >
      <QueryClientProvider client={queryClient}>
        <WagmiProvider config={wagmiConfig}>{children}</WagmiProvider>
      </QueryClientProvider>
    </Privy>
  );
}
