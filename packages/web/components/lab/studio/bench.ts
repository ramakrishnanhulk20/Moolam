"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import { RUN, type BenchState, type Path } from "./fixtures";

/**
 * What both drawings are showing, and the two ways it changes: the dial, and a
 * press on the drawing's own button.
 *
 * One state for the page, not one per drawing, so the same pose is on screen in
 * both of them and Ram is comparing two designs rather than two moments.
 */
export interface Bench {
  path: Path;
  state: BenchState;
  /** True while a pressed run is playing itself out. */
  running: boolean;
  /** When the current state began, in milliseconds on the browser's own clock. */
  since: number;
  choose: (path: Path) => void;
  show: (state: BenchState) => void;
  press: () => void;
}

export function useBench(): Bench {
  const [path, setPath] = useState<Path>("upload");
  const [state, setState] = useState<BenchState>("idle");
  const [running, setRunning] = useState(false);
  const [since, setSince] = useState(0);
  const timers = useRef<number[]>([]);

  const clear = useCallback(() => {
    for (const timer of timers.current) {
      window.clearTimeout(timer);
    }
    timers.current = [];
  }, []);

  useEffect(() => clear, [clear]);

  const show = useCallback(
    (next: BenchState) => {
      clear();
      setRunning(false);
      setState(next);
      setSince(Date.now());
    },
    [clear],
  );

  const choose = useCallback(
    (next: Path) => {
      clear();
      setRunning(false);
      setPath(next);
      setState("idle");
      setSince(Date.now());
    },
    [clear],
  );

  /**
   * The whole run, played at the speeds a real one takes. A pose picked off the
   * dial shows one moment; this is the only way to judge whether the press
   * reads as an answer.
   */
  const press = useCallback(() => {
    clear();
    setRunning(true);
    setState(RUN[0].state);
    setSince(Date.now());

    for (const beat of RUN.slice(1)) {
      timers.current.push(
        window.setTimeout(() => {
          setState(beat.state);
          setSince(Date.now());
          if (beat === RUN[RUN.length - 1]) {
            setRunning(false);
          }
        }, beat.after),
      );
    }
  }, [clear]);

  return { path, state, running, since, choose, show, press };
}

/** The room left between the sticky strip and the panel's top after a press. */
const GAP = 16;

/** How long the button holds the press on itself before the panel changes. */
const ACKNOWLEDGED = 220;

/**
 * Where the page has to go for the answer to a press to be on screen.
 *
 * panelTop is where the panel's top sits on the screen, stickyBottom is how much
 * of the top of the screen is already spoken for (on the bench the bar over every
 * page plus the dial strip, on the real studio the bar alone), and the answer is
 * how far the page has to move. It is null when the top already sits in the good
 * band: under the sticky strip and no lower than a third of the way down, which
 * is where the whole first screen of progress is already readable.
 */
export function scrollTarget(panelTop: number, stickyBottom: number, viewportHeight: number): number | null {
  if (panelTop >= stickyBottom && panelTop <= viewportHeight / 3) {
    return null;
  }
  return panelTop - stickyBottom - GAP;
}

/** How much of the top of the screen is spoken for above this panel. */
function stickyAbove(panel: HTMLElement): number {
  const style = getComputedStyle(panel);
  for (const name of ["--bench-top", "--header-h"]) {
    const height = Number.parseFloat(style.getPropertyValue(name));
    if (Number.isFinite(height)) {
      return height;
    }
  }
  return 0;
}

/**
 * Puts the panel's top just under the sticky strip, in one move.
 *
 * One scroll is enough, with nothing held afterwards: both drawings reserve the
 * height of what comes next, and the bench turns the browser's own scroll
 * anchoring off, which was the thing that used to undo this half a second later.
 * A reader who wants to be somewhere else can leave the moment it lands.
 */
export function bringIntoView(panel: HTMLElement | null, reduced: boolean): void {
  if (panel === null) {
    return;
  }

  const move = scrollTarget(panel.getBoundingClientRect().top, stickyAbove(panel), window.innerHeight);
  if (move === null) {
    return;
  }

  window.scrollTo({
    top: Math.max(0, window.scrollY + move),
    behavior: reduced ? "instant" : "smooth",
  });
}

/**
 * The press, answered in two beats: the button first, the panel after.
 *
 * The label on the button becomes the run's first line and the button goes quiet
 * in the same frame the thumb comes off it, so the press is acknowledged before
 * anything on the page moves. A beat later the panel turns or folds and the page
 * brings its top into view.
 */
export function usePressed(
  panel: RefObject<HTMLElement | null>,
  bench: Bench,
): { pressing: boolean; press: () => void; again: () => void } {
  const reduced = useIsReducedMotion();
  const [pressing, setPressing] = useState(false);
  const wanted = useRef(false);
  const timer = useRef(0);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  useLayoutEffect(() => {
    if (wanted.current) {
      wanted.current = false;
      bringIntoView(panel.current, reduced);
    }
  }, [bench.state, panel, reduced]);

  const press = useCallback(() => {
    window.clearTimeout(timer.current);
    setPressing(true);
    timer.current = window.setTimeout(() => {
      setPressing(false);
      wanted.current = true;
      bench.press();
    }, ACKNOWLEDGED);
  }, [bench]);

  const again = useCallback(() => {
    wanted.current = true;
    bench.show("idle");
  }, [bench]);

  return { pressing, press, again };
}

/**
 * Holds one section still across a change somewhere above it.
 *
 * Reading the dial changes the height of both drawings, and the lower one would
 * slide under the reader without this. Take the measure before the change and
 * call what it hands back after it.
 */
export function holdStill(section: HTMLElement | null): () => void {
  if (section === null) {
    return () => undefined;
  }
  const before = section.getBoundingClientRect().top;
  return () => {
    const after = section.getBoundingClientRect().top;
    if (Math.round(after - before) !== 0) {
      window.scrollBy({ top: Math.round(after - before), behavior: "instant" });
    }
  };
}
