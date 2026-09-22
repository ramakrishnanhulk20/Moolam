"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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

/**
 * Keeps the pressed pixel where the thumb left it.
 *
 * The panel is taller than a phone screen, so swapping its face alone would
 * leave the creator looking at whatever the page put in that place afterwards,
 * which is the whole complaint this bench exists to answer. Called in a layout
 * effect, this puts the new face's own top under the press in the same frame:
 * the thing they touched turns into the thing they asked for.
 *
 * The hold afterwards is not belt and braces. The page gets much shorter when a
 * long form folds away, and the smooth scroll library re-clamps its own idea of
 * where the page is a few hundred milliseconds later, which threw the answer off
 * the top of the screen. The hold ends the moment the reader takes the page
 * back, so it can never fight a scroll of their own.
 */
export function anchorTo(panel: HTMLElement | null, pressedAt: number): void {
  if (panel === null) {
    return;
  }

  const settle = () => {
    const top = panel.getBoundingClientRect().top + window.scrollY;
    const want = Math.max(0, Math.round(top - pressedAt));
    if (Math.round(window.scrollY) !== want) {
      window.scrollTo({ top: want, behavior: "instant" });
    }
  };

  settle();

  const until = Date.now() + 1_100;
  let frame = 0;
  const stop = () => {
    cancelAnimationFrame(frame);
    window.removeEventListener("wheel", stop);
    window.removeEventListener("touchstart", stop);
    window.removeEventListener("keydown", stop);
  };

  const hold = () => {
    settle();
    if (Date.now() < until) {
      frame = requestAnimationFrame(hold);
    } else {
      stop();
    }
  };
  frame = requestAnimationFrame(hold);

  window.addEventListener("wheel", stop, { passive: true });
  window.addEventListener("touchstart", stop, { passive: true });
  window.addEventListener("keydown", stop);
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
