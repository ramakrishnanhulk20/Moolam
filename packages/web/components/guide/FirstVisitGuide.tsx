"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { usePathname } from "@/lib/i18n/routing";
import { GuideWalk } from "./GuideWalk";
import { guideShouldShowHere, markGuideSeen, onLabPage } from "./seen";
import { GUIDE_OPEN_EVENT } from "./signal";

const watchers = new Set<() => void>();

/**
 * The marks are read during render, so React needs telling when one of them
 * changes. The storage event covers another tab; the call below covers this one.
 */
function watchMarks(listener: () => void): () => void {
  watchers.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    watchers.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function marksChanged(): void {
  for (const listener of watchers) {
    listener();
  }
}

/**
 * The first visit guide, as it ships: three steps over the real page, once per
 * device.
 *
 * Nothing is rendered on the server and nothing on the first client pass
 * either, because the answer lives in this browser's storage and a server that
 * guessed would hand React a tree that does not match the one it is hydrating.
 * useSyncExternalStore is how the rest of this app reads a browser only fact:
 * the server snapshot is "no", the real one lands in the pass straight after.
 *
 * Every way out writes the mark, including following a step's link, so nobody
 * is asked twice. The footer entry forgets the mark and shouts, which is why
 * there is a second way in that ignores the mark entirely.
 */
export function FirstVisitGuide() {
  const path = usePathname();
  const [asked, setAsked] = useState(false);

  const first = useSyncExternalStore(
    watchMarks,
    () => (guideShouldShowHere(path) ? "yes" : "no"),
    () => "no",
  );

  useEffect(() => {
    const open = () => setAsked(true);
    window.addEventListener(GUIDE_OPEN_EVENT, open);
    return () => window.removeEventListener(GUIDE_OPEN_EVENT, open);
  }, []);

  const close = useCallback(() => {
    markGuideSeen();
    setAsked(false);
    marksChanged();
  }, []);

  // A bench page is where this was drawn, and a guide over a drawing of itself
  // helps nobody. It is the one place the footer entry is deliberately quiet.
  const open = !onLabPage(path) && (asked || first === "yes");

  return <GuideWalk open={open} onClose={close} />;
}
