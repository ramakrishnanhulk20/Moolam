"use client";

import { Component, Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { FilmFailed } from "@/components/home/FilmFailed";

/** The moves that say a reader is on their way down the page. */
const MOVES = ["wheel", "touchmove", "scroll", "keydown"] as const;

/**
 * Holds the film back until the reader moves toward it.
 *
 * The film is two thirds of a megabyte of React, three.js and the scene, and
 * its first pictures are asked for as soon as it is on the page. With the first
 * screen above it, none of that is anything a reader can see yet, and on a slow
 * phone it would share the line with the pictures they can. So the film's box
 * is held open at its full height, carrying the same attribute the film's own
 * loading box carries so the page's rules treat it the same way, and the film
 * itself is only mounted on the first wheel turn, drag, scroll or key, or the
 * moment any of the box is on screen in a window tall enough to show it.
 */
export function FilmGate({ children }: { children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (open) {
      return;
    }
    const go = () => setOpen(true);
    for (const move of MOVES) {
      window.addEventListener(move, go, { passive: true, once: true });
    }

    // A box that only touches the foot of the window reports itself as
    // intersecting with nothing of it showing, so only a real share counts.
    const watch = new IntersectionObserver(
      ([entry]) => {
        if (entry !== undefined && entry.intersectionRatio > 0) {
          go();
        }
      },
      { threshold: [0, 0.01] },
    );
    if (box.current !== null) {
      watch.observe(box.current);
    }

    return () => {
      for (const move of MOVES) {
        window.removeEventListener(move, go);
      }
      watch.disconnect();
    };
  }, [open]);

  if (open) {
    return <FilmCatch>{children}</FilmCatch>;
  }

  return (
    <div ref={box} className="story" data-motif="seal" data-film-gate>
      <div className="h-[100svh] w-full bg-bg" data-story="loading" />
    </div>
  );
}

/**
 * Keeps a film that would not load, or broke on its first frame, inside its
 * own box.
 *
 * In this version of Next a dynamic import that fails never reaches the
 * import's loading box: that box is only ever handed a null error. The failure
 * is thrown where the film would render, and without a catch here it climbs to
 * the page's error screen and takes the first screen and the footer with it.
 *
 * Try again mounts the film under a new key, and the story's own import hands
 * out a fresh attempt after a failure, so the press really asks for the code
 * again. Nothing retries by itself: a second failure lands on the same box.
 */
class FilmCatch extends Component<{ children: ReactNode }, { failed: boolean; attempt: number }> {
  state = { failed: false, attempt: 0 };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  retry = () => {
    this.setState(({ attempt }) => ({ failed: false, attempt: attempt + 1 }));
  };

  render() {
    if (this.state.failed) {
      return <FilmFailed onRetry={this.retry} />;
    }
    return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;
  }
}
