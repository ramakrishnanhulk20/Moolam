"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * The poster's picture sinks a little slower than the page as the reader
 * scrolls, which is what makes the words read as standing in front of it.
 *
 * The offset is written straight onto the element from an animation frame, so
 * React never renders per frame, and it only ever moves a transform: nothing
 * around it is pushed, so the page has no layout shift to show for it. A reader
 * who asked for less motion gets the picture standing still.
 */
export function Drift({ children, rate = 0.22, className = "" }: { children: ReactNode; rate?: number; className?: string }) {
  const node = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = node.current;
    if (element === null || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }

    let frame = 0;
    const paint = () => {
      frame = 0;
      const offset = Math.min(window.scrollY, window.innerHeight * 1.5) * rate;
      element.style.transform = `translate3d(0, ${offset.toFixed(1)}px, 0) scale(1.06)`;
    };
    const onScroll = () => {
      if (frame === 0) {
        frame = requestAnimationFrame(paint);
      }
    };

    paint();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame !== 0) {
        cancelAnimationFrame(frame);
      }
    };
  }, [rate]);

  return (
    <div ref={node} className={`will-change-transform ${className}`} style={{ transform: "scale(1.06)" }}>
      {children}
    </div>
  );
}
