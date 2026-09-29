"use client";

import dynamic from "next/dynamic";
import { useSyncExternalStore } from "react";
import type { Hex } from "viem";
import { useWalletMounted } from "@/components/providers/WalletProvider";
import type { UnsealResponse } from "@/lib/verifier/client";

// Same shape as the edit panel next to it: the wallet SDK lives behind this one
// import, so a reader who never signs in downloads a sealed passport page
// without any of it. There is nothing to draw until the chunk lands, which is
// what everyone except the holder sees anyway.
const Unsealer = dynamic(() => import("./Unsealer").then((module) => module.Unsealer), {
  ssr: false,
  loading: () => null,
});

/**
 * What this visit knows about a publish that already happened here: the
 * receipt, whether the page has turned public since, and the two calls that
 * keep the receipt and bring it into view once.
 */
export interface PublishedVisit {
  receipt: UnsealResponse | undefined;
  settled: boolean;
  keep: (result: UnsealResponse) => void;
  /** True the first time it is asked for a passport, and never again this visit. */
  firstReveal: () => boolean;
}

// Held at module level, not in component state, because the refresh after
// Publish turns the page public and the panel's own state goes with it. These
// last until the tab is closed or reloaded, which is the visit.
const receipts = new Map<string, UnsealResponse>();
const revealed = new Set<string>();
const listeners = new Set<() => void>();

const keyOf = (passportId: string): string => passportId.toLowerCase();

/** Keeps the Published receipt for this passport for the rest of the visit. */
export function keepReceipt(passportId: Hex, result: UnsealResponse): void {
  const key = keyOf(passportId);
  if (receipts.get(key) === result) {
    return;
  }
  receipts.set(key, result);
  for (const notify of listeners) {
    notify();
  }
}

/** The receipt this visit kept for a passport, if Publish succeeded here. */
export function keptReceipt(passportId: Hex): UnsealResponse | undefined {
  return receipts.get(keyOf(passportId));
}

/** True the first time only, so the receipt scrolls into view once and never pulls the reader back later. */
export function firstReveal(passportId: Hex): boolean {
  const key = keyOf(passportId);
  if (revealed.has(key)) {
    return false;
  }
  revealed.add(key);
  return true;
}

/** Whether the panel draws at all: while sealed, or once this visit published the picture. */
export function showsUnsealPanel(sealed: boolean, receipt: UnsealResponse | undefined): boolean {
  return sealed || receipt !== undefined;
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
  };
}

/**
 * The holder's publish control on a sealed passport.
 *
 * Drawn for one reader only, the wallet the registry says holds this passport,
 * and only while the passport is still sealed. Everybody else gets no markup at
 * all rather than a button they could never press, because the one thing this
 * panel does cannot be undone and has no business on a stranger's screen.
 *
 * The one exception is the holder who has just published from this page: the
 * refresh turns the passport public, and the receipt with its four addresses
 * stays where they were reading it instead of vanishing under them.
 */
export function UnsealPanel({ passportId, owner, sealed }: { passportId: Hex; owner: Hex | null; sealed: boolean }) {
  // The server has no receipts, so its answer is the same empty one a first
  // load gets in the browser, and hydration never disagrees.
  const receipt = useSyncExternalStore(
    subscribe,
    () => keptReceipt(passportId),
    () => keptReceipt(passportId),
  );

  if (!showsUnsealPanel(sealed, receipt)) {
    return null;
  }
  return (
    <Gate
      passportId={passportId}
      owner={owner}
      visit={{
        receipt,
        settled: !sealed,
        keep: (result) => keepReceipt(passportId, result),
        firstReveal: () => firstReveal(passportId),
      }}
    />
  );
}

function Gate({ passportId, owner, visit }: { passportId: Hex; owner: Hex | null; visit: PublishedVisit }) {
  return useWalletMounted() ? <Unsealer passportId={passportId} owner={owner} visit={visit} /> : null;
}
