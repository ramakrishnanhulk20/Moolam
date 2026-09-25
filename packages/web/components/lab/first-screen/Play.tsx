"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * Holds the evidence board's moment until the reader can see it.
 *
 * The server sends the board already playing, so a desktop, where the board is
 * on the first screen, gets the moment on load with no script at all. On a
 * phone the board is a scroll below, so once this runs it is set back to the
 * start and played again the moment it comes into view. Nothing that is on the
 * screen is ever hidden by this: the board is only reset while it is out of
 * sight.
 */
export function Play({ children, className = "" }: { children: ReactNode; className?: string }) {
  const node = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = node.current;
    if (element === null) {
      return;
    }
    const box = element.getBoundingClientRect();
    if (box.top < window.innerHeight && box.bottom > 0) {
      return;
    }

    element.dataset.play = "wait";
    const watch = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting === true) {
          element.dataset.play = "go";
          watch.disconnect();
        }
      },
      { threshold: 0.35 },
    );
    watch.observe(element);
    return () => watch.disconnect();
  }, []);

  return (
    <div ref={node} data-play="go" className={className}>
      {children}
    </div>
  );
}
