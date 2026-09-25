"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { GuideWalk } from "./GuideWalk";
import { guideShouldShowHere, markGuideSeen } from "./seen";
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
 * Whether the words under the mark have finished arriving: every rise and fade
 * that runs once has run. A pulse or a ping that runs for ever is not waited
 * for, and a browser that cannot list its animations is taken as settled.
 */
export function heroSettled(node: Element): boolean {
  if (typeof node.getAnimations !== "function") {
    return true;
  }
  return node.getAnimations({ subtree: true }).every((animation) => {
    const end = Number(animation.effect?.getComputedTiming().endTime ?? 0);
    return animation.playState !== "running" || !Number.isFinite(end);
  });
}

/**
 * Whether the home page's first screen has painted its words.
 *
 * The first screen carries the mark in the server's markup, because its words
 * are in the first paint. What is still moving is the rise of the drop and the
 * second call under the headline, so the walk waits for those to settle before
 * it dims the screen and points at things. It never waits for the film below:
 * the film is only mounted once the reader moves toward it, and a walk that
 * waited for it opened over the first screen a second after the first scroll.
 *
 * Read on each animation frame, and only while the walk is waiting to open.
 * Once the words have been seen settled the looking stops for good.
 */
function useHeroPainted(wanted: boolean): boolean {
  const [painted, setPainted] = useState(false);

  useEffect(() => {
    if (!wanted || painted) {
      return;
    }
    let frame = 0;
    const look = () => {
      const hero = document.querySelector("[data-hero-shown]");
      if (hero !== null && heroSettled(hero)) {
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
  const [asked, setAsked] = useState(false);

  const first = useSyncExternalStore(
    watchMarks,
    () => (guideShouldShowHere() ? "yes" : "no"),
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

  const wanted = asked || first === "yes";
  const open = useHeroPainted(wanted) && wanted;

  return <GuideWalk open={open} onClose={close} />;
}
