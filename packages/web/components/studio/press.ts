"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { GENERATE_STEPS, STEPS, type RegisterState } from "@/lib/studio/flow";
import { LAPTOP, WIDE_REACH } from "./layout";

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
 * Proved in a real browser at 1920x1080, 1440x900 and 375x812.
 *
 * `reach` is how far down the screen the top may sit. The wide layout passes
 * a half: its band lands beside the picture at the top of the right column, so
 * a box that starts in the upper half already shows the run, and moving the
 * page there would be a jump with nothing gained.
 */
export function scrollTarget(
  boxTop: number,
  stickyBottom: number,
  viewportHeight: number,
  reach = 1 / 3,
): number | null {
  if (boxTop >= stickyBottom && boxTop <= viewportHeight * reach) {
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
export function bringIntoView(box: HTMLElement | null, reduced: boolean, reach?: number): void {
  if (box === null) {
    return;
  }

  const move = scrollTarget(box.getBoundingClientRect().top, stickyAbove(box), window.innerHeight, reach);
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

/** The band's own heading, which takes focus when the form folds into the run. */
export const BAND_HEADING = "[data-band-heading]";

/** Anything a keyboard can land on in a fresh form, in the order the markup gives. */
export const FORM_CONTROL =
  'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), a[href]';

/** Where focus goes when the panel changes face: the band after a fold, the form's first control after Register another. */
export function foldFocusTarget(folded: boolean): string {
  return folded ? BAND_HEADING : FORM_CONTROL;
}

/**
 * Keeps keyboard focus in the box when the face it was on goes away.
 *
 * Register folds the form, and Register another (Make another on the agent
 * path) brings it back. Both times the button that held focus is removed with
 * the face it sat on, so focus falls to the top of the page. This puts it on
 * the band's heading after a fold and on the first control of the fresh form
 * after a return.
 *
 * The page has already been moved by useStudioPress, so focus is placed without
 * a scroll of its own. It only moves when the press took focus down with it: a
 * creator who has since tabbed somewhere else keeps their place.
 */
export function useFoldFocus(panel: RefObject<HTMLElement | null>, folded: boolean): void {
  const was = useRef(folded);

  useEffect(() => {
    if (was.current === folded) {
      return;
    }
    was.current = folded;

    const root = panel.current;
    if (root === null) {
      return;
    }
    const held = document.activeElement;
    if (held !== null && held !== document.body && !root.contains(held)) {
      return;
    }
    firstShown(root, foldFocusTarget(folded))?.focus({ preventScroll: true });
  }, [panel, folded]);
}

/** The first match that is drawn: a hidden file input or a laptop-only copy is skipped. */
function firstShown(root: HTMLElement, selector: string): HTMLElement | null {
  for (const node of root.querySelectorAll<HTMLElement>(selector)) {
    if (node.getClientRects().length > 0) {
      return node;
    }
  }
  return null;
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
 *
 * `wide` gives the move the wide layout's reach, but only on a laptop: under lg
 * the wide studio is the one column it always was, and keeps its third.
 */
export function useStudioPress(
  box: RefObject<HTMLElement | null>,
  folded: boolean,
  reduced: boolean,
  wide = false,
): { pressing: boolean; press: (run: () => void) => void } {
  const [pressing, setPressing] = useState(false);
  const timer = useRef(0);
  const was = useRef(folded);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  useLayoutEffect(() => {
    if (was.current !== folded) {
      was.current = folded;
      bringIntoView(box.current, reduced, wide && window.matchMedia(LAPTOP).matches ? WIDE_REACH : undefined);
    }
  }, [box, folded, reduced, wide]);

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
