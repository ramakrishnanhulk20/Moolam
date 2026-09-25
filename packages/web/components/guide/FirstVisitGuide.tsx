"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { usePathname } from "@/lib/i18n/routing";
import { GuideWalk } from "./GuideWalk";
import { guideShouldShowHere, markGuideSeen, onLabPage } from "./seen";
import { GUIDE_OPEN_EVENT, takeGuideRequest } from "./signal";

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
 * Whether the home page's first screen has painted its words.
 *
 * The hero's credit block raises the mark once its title has settled and its
 * two calls have finished rising. The walk introduces that screen, so it waits
 * for it: on a slow phone the walk used to open 3.7 seconds before the hero,
 * over a black page, and dim the hero's arrival when it came.
 *
 * Read the way the bottom bar reads the film, by looking at the page on each
 * animation frame, and only while the walk is waiting to open. Once the mark
 * has been seen the looking stops for good.
 */
function useHeroPainted(wanted: boolean): boolean {
  const [painted, setPainted] = useState(false);

  useEffect(() => {
    if (!wanted || painted) {
      return;
    }
    let frame = 0;
    const look = () => {
      if (document.querySelector("[data-hero-shown]") !== null) {
        setPainted(true);
        return;
      }
      frame = requestAnimationFrame(look);
    };
    frame = requestAnimationFrame(look);
    return () => cancelAnimationFrame(frame);
  }, [wanted, painted]);

  return painted;
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
 * It opens only once the hero it introduces is on the screen: see
 * useHeroPainted above.
 *
 * Every way out writes the mark, including following a step's link, so nobody
 * is asked twice. The footer entry forgets the mark and shouts, or, from
 * another page, leaves a note and comes here, which is why there is a second
 * way in that ignores the mark entirely.
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
    // The footer on another page cannot shout across a navigation, so it
    // leaves a note and brings the reader here. The note is spent on arrival,
    // which keeps a reload of this page from opening the walk again.
    if (takeGuideRequest()) {
      open();
    }
    return () => window.removeEventListener(GUIDE_OPEN_EVENT, open);
  }, []);

  const close = useCallback(() => {
    markGuideSeen();
    setAsked(false);
    marksChanged();
  }, []);

  // A lab page is a bench for the product itself, and a guide laid over one
  // helps nobody. It is the one place the footer entry is deliberately quiet.
  const wanted = !onLabPage(path) && (asked || first === "yes");
  const open = useHeroPainted(wanted) && wanted;

  return <GuideWalk open={open} onClose={close} />;
}
