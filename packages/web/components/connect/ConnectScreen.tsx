"use client";

import { MotionConfig } from "framer-motion";
import dynamic from "next/dynamic";
import { useEffect } from "react";
import { useWalletMounted } from "@/components/providers/WalletProvider";
import type { OriginAsker } from "@/lib/data/platform-label";
import { isPrivyConfigured } from "@/lib/env";
import { ConnectPanel } from "./ConnectPanel";

const loadLive = () => import("./ConnectLive").then((module) => module.ConnectLive);

const ignore = () => undefined;

const ConnectLive = dynamic(loadLive);

/**
 * The page a platform opens when it asks for a person's Moolam address. Until
 * the wallet SDK is up the panel shows who is asking and waits for the account,
 * and nothing can be shared.
 */
export function ConnectScreen({ asker }: { asker: OriginAsker }) {
  const mounted = useWalletMounted();

  useEffect(() => {
    if (isPrivyConfigured) {
      void loadLive();
    }
  }, []);

  return (
    <MotionConfig reducedMotion="user">
      {mounted ? (
        <ConnectLive asker={asker} />
      ) : (
        <ConnectPanel asker={asker} wallet={null} signedIn={null} onSignIn={ignore} />
      )}
    </MotionConfig>
  );
}
