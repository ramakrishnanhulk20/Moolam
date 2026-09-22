"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { GENERATE_STEPS, STEPS, type RegisterState } from "@/lib/studio/flow";

/** The room left between the bar at the top of the page and the box's top after a press. */
const GAP = 16;

/** How long the button holds the press on itself before the box changes. */
const ACKNOWLEDGED = 220;

/**
 * Where the page has to go for the answer to a press to be on screen.
 *
 * boxTop is where the box's top sits on the screen, stickyBottom is how much of
 * the top of the screen is already spoken for, and the answer is how far the
 * page has to move. It is null when the top already sits in the good band: under
 * the bar and no lower than a third of the way down, which is where the whole
 * first screen of progress is already readable.
 *
 * Proved on the bench in WO-124b at 1920x1080, 1440x900 and 375x812.
 */
export function scrollTarget(boxTop: number, stickyBottom: number, viewportHeight: number): number | null {
  if (boxTop >= stickyBottom && boxTop <= viewportHeight / 3) {
    return null;
  }
  return boxTop - stickyBottom - GAP;
}

/**
 * How much of the top of the screen the bar is holding.
 *
 * Measured rather than read from --header-h, because the bar wraps to two rows
 * on a narrow laptop and the variable says 63 px whatever it does. There are two
 * bars in the markup, one for phones and one from md, and the hidden one
 * measures zero, so the taller of them is the one on screen. The variable is the
 * fallback for anywhere this box is used without that bar.
 */
export function stickyAbove(box: HTMLElement): number {
  let tallest = 0;
  for (const bar of document.querySelectorAll(".app-header")) {
    const seat = getComputedStyle(bar).position;
    if (seat === "sticky" || seat === "fixed") {
      tallest = Math.max(tallest, bar.getBoundingClientRect().height);
    }
  }
  if (tallest > 0) {
    return Math.round(tallest);
  }

  const named = Number.parseFloat(getComputedStyle(box).getPropertyValue("--header-h"));
  return Number.isFinite(named) ? named : 0;
}

/**
 * Puts the box's top just under the bar, in one move.
 *
 * One scroll, nothing held afterwards: the box reserves the height of what comes
 * next and the screen turns the browser's own scroll anchoring off, which was
 * the thing that used to undo this half a second later.
 */
export function bringIntoView(box: HTMLElement | null, reduced: boolean): void {
  if (box === null) {
    return;
  }

  const move = scrollTarget(box.getBoundingClientRect().top, stickyAbove(box), window.innerHeight);
  if (move === null) {
    return;
  }

  window.scrollTo({
    top: Math.max(0, window.scrollY + move),
    behavior: reduced ? "instant" : "smooth",
  });
}

/**
 * The bar's height, watched, so the band can pin itself just under it.
 *
 * It is a measurement rather than --header-h for the same reason the scroll is:
 * the bar wraps to two rows on a narrow laptop and the variable does not move.
 */
export function useStickyTop(box: RefObject<HTMLElement | null>): number | null {
  const [top, setTop] = useState<number | null>(null);

  useEffect(() => {
    const measure = () => {
      const node = box.current;
      if (node !== null) {
        setTop(stickyAbove(node));
      }
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [box]);

  return top;
}

/** True once this run has actually started, which is what folds the form away. */
export function hasStarted(state: RegisterState): boolean {
  const steps = state.mode === "generate" ? GENERATE_STEPS : STEPS;
  return steps.some((step) => state.steps[step] !== "waiting");
}

/**
 * The press, answered in two beats: the button first, the box after.
 *
 * The label on the button becomes the run's first line and the button goes quiet
 * in the same frame the thumb comes off it, so the press is acknowledged before
 * anything on the page moves. A beat later the run starts, the form folds into
 * the band, and the page brings the box's top under the bar.
 *
 * The same move runs when the form comes back, so Make another lands on a clean
 * form rather than wherever the receipt left the page.
 */
export function useStudioPress(
  box: RefObject<HTMLElement | null>,
  folded: boolean,
  reduced: boolean,
): { pressing: boolean; press: (run: () => void) => void } {
  const [pressing, setPressing] = useState(false);
  const timer = useRef(0);
  const was = useRef(folded);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  useLayoutEffect(() => {
    if (was.current !== folded) {
      was.current = folded;
      bringIntoView(box.current, reduced);
    }
  }, [box, folded, reduced]);

  const press = useCallback((run: () => void) => {
    window.clearTimeout(timer.current);
    setPressing(true);
    timer.current = window.setTimeout(() => {
      setPressing(false);
      run();
    }, ACKNOWLEDGED);
  }, []);

  return { pressing, press };
}
