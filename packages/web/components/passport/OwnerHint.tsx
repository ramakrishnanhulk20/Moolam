"use client";

import { motion } from "framer-motion";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { useState, useSyncExternalStore } from "react";
import type { Hex } from "viem";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import { RETURNING_KEY, useWalletMounted } from "@/components/providers/WalletProvider";
import { isPrivyConfigured } from "@/lib/env";

// Both halves reach the wallet SDK, so they arrive in a chunk of their own and a
// reader who never presses Sign in downloads none of it.
const SignedOutCheck = dynamic(() => import("./OwnerHintWallet").then((module) => module.SignedOutCheck), {
  ssr: false,
  loading: () => null,
});
const SignInHere = dynamic(() => import("./OwnerHintWallet").then((module) => module.SignInHere), {
  ssr: false,
  loading: () => null,
});

/**
 * Whether the hint is drawn. `signedIn` is null while nobody can tell yet, and
 * the hint waits rather than flashing at a holder whose session is still loading.
 * A holder is always signed in, so the hint never sits beside their own controls.
 */
export function ownerHintShows(reader: { privy: boolean; owner: Hex | null; signedIn: boolean | null }): boolean {
  return reader.privy && reader.owner !== null && reader.signedIn === false;
}

/** Nothing pushes the mark at this line; it is read again on any later render. */
const noWatch = () => () => undefined;

/** Whether this device has signed in to Moolam before. Storage that refuses counts as new. */
function returningDevice(): boolean {
  try {
    return window.localStorage.getItem(RETURNING_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * One quiet line for a signed-out reader: the person who made this picture is
 * told how to reach its controls, which are otherwise invisible to them.
 *
 * A passport only fetches the wallet for a device that has signed in before, so
 * on a new device nobody can ask Privy whether the reader is signed in. There
 * the reader is signed out by definition, and pressing Sign in loads the wallet
 * right here.
 */
export function OwnerHint({ owner }: { owner: Hex | null }) {
  const mounted = useWalletMounted();
  // Read through the store hook, so the server and the first paint agree on
  // showing nothing and the real answer follows on the next render.
  const returning = useSyncExternalStore(noWatch, returningDevice, () => null);
  const [live, setLive] = useState<boolean | null>(null);
  const [asks, setAsks] = useState(0);

  // A returning device is about to mount the wallet, and the answer comes from there.
  const signedIn = mounted ? live : returning === null || returning ? null : false;
  const shows = ownerHintShows({ privy: isPrivyConfigured, owner, signedIn });

  return (
    <>
      {mounted ? <SignedOutCheck onAnswer={setLive} asks={asks} /> : null}
      {!mounted && asks > 0 ? <SignInHere asks={asks} /> : null}
      {shows ? <HintLine onSignIn={() => setAsks((count) => count + 1)} /> : null}
    </>
  );
}

export function HintLine({ onSignIn }: { onSignIn: () => void }) {
  const t = useTranslations("passport");
  const reduced = useIsReducedMotion();

  return (
    <motion.div
      data-owner-hint
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduced ? 0.15 : 0.5, ease: [0.16, 1, 0.3, 1] }}
      className="mt-16 flex flex-wrap items-center gap-x-5 gap-y-3 border-t border-line pt-6"
    >
      <span aria-hidden className="motif h-[8px] w-[8px] opacity-60" />
      <p className="text-base leading-relaxed text-text-muted">{t("ownerHint")}</p>
      <button
        type="button"
        onClick={onSignIn}
        className="tap rounded-[8px] border border-line-strong px-4 py-2 font-mono text-[10px] uppercase tracking-[0.2em] text-text transition-colors duration-200 hover:border-accent hover:text-accent"
      >
        {t("consent.control.actions.signIn")}
      </button>
    </motion.div>
  );
}
