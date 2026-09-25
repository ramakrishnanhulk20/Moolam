"use client";

import { MotionConfig } from "framer-motion";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { isPrivyConfigured } from "@/lib/env";
import { useWalletMounted } from "@/components/providers/WalletProvider";
import type { Mode } from "@/lib/studio/flow";
import { WideLayout } from "./layout";
import { EmptyReceipt } from "./ReceiptFrame";
import { Notice, StudioBox, StudioWaiting } from "./StudioFrame";

const loadLive = () => import("./LiveStudio").then((module) => module.LiveStudio);

// The waiting paint stands in while the live studio's own code arrives, so the
// card, the stub and everything under them hold still across the swap.
const LiveStudio = dynamic(loadLive, { loading: () => <Waiting /> });

/**
 * The studio as the page first paints it, and the gate to the live one.
 *
 * Privy is optional at build time, so the hook that needs its context only
 * ever mounts under a configured app id and the page says plainly what is
 * missing otherwise.
 *
 * The hook is also held back until the SDK's provider is actually above this
 * screen. Called without it, Privy's own hooks warn into the console on every
 * render and answer ready false, so the page paints its waiting state from
 * here instead and mounts the hook once the wallet is really there.
 *
 * This file is kept small on purpose, because it is what a phone downloads
 * before it can run anything on the page: the waiting card and the empty stub.
 * The hook, Privy's hooks and every card a signed in creator walks through live
 * in LiveStudio.tsx, fetched beside the wallet SDK once the page has painted.
 *
 * On a laptop a signed in creator gets the wide layout: the picture on the
 * left, the details and the button on the right.
 */
export function StudioScreen({ initialMode }: { initialMode?: Mode }) {
  const mounted = useWalletMounted();

  // Asked for beside the wallet SDK rather than after it, so the two arrive
  // together instead of one waiting on the other.
  useEffect(() => {
    if (isPrivyConfigured) {
      void loadLive();
    }
  }, []);

  if (!isPrivyConfigured) {
    return <NotConfigured />;
  }

  return (
    <WideLayout>{mounted ? <LiveStudio initialMode={initialMode} /> : <Waiting />}</WideLayout>
  );
}

/** The page before the wallet arrives: the same frame and the same card the hook paints while it is not ready. */
function Waiting() {
  return (
    <MotionConfig reducedMotion="user">
      <StudioBox>
        <StudioWaiting />
        <EmptyReceipt />
      </StudioBox>
    </MotionConfig>
  );
}

function NotConfigured() {
  const t = useTranslations("studio");
  return <Notice text={t("notConfigured")} tone="failed" />;
}
