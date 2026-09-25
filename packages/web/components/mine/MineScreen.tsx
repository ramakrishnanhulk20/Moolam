"use client";

import { MotionConfig } from "framer-motion";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { useWalletMounted } from "@/components/providers/WalletProvider";
import { isPrivyConfigured } from "@/lib/env";
import { MineNotice, MineWaiting } from "./MineFrame";

const loadPictures = () => import("./MinePictures").then((module) => module.MinePictures);

// The waiting card stands in while the signed in half arrives, so nothing under
// it moves across the swap.
const MinePictures = dynamic(loadPictures, { loading: () => <MineWaiting /> });

/**
 * A person's own pictures, one tap from the bar on every page.
 *
 * The hook that reads Privy only mounts once the SDK's provider is really above
 * this screen, the way the studio does it. Called any earlier, Privy's hooks
 * warn on every render and answer ready false, so the page paints its waiting
 * state from here instead.
 *
 * This file is what a phone downloads before it can run anything here, so it
 * holds only the waiting card. Privy's hooks and the grid are in
 * MinePictures.tsx and OwnPictures.tsx, fetched beside the wallet SDK once the
 * page has painted.
 */
export function MineScreen() {
  const mounted = useWalletMounted();
  const studio = useTranslations("studio");

  // Asked for beside the wallet SDK rather than after it, so the two arrive
  // together instead of one waiting on the other.
  useEffect(() => {
    if (isPrivyConfigured) {
      void loadPictures();
    }
  }, []);

  return (
    <MotionConfig reducedMotion="user">
      {!isPrivyConfigured ? (
        <MineNotice text={studio("notConfigured")} tone="failed" />
      ) : mounted ? (
        <MinePictures />
      ) : (
        <MineWaiting />
      )}
    </MotionConfig>
  );
}
