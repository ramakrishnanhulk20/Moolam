"use client";

import { useEffect, useRef } from "react";

/**
 * How far through the page you are, drawn as one accent line across the top of
 * the window.
 *
 * The work happens against the frame clock and writes a transform straight onto
 * the element, so scrolling a long reference page never re-renders React.
 */
export function ReadingLine() {
  const line = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const bar = line.current;
    const article = document.querySelector<HTMLElement>("[data-docs-article]");
    if (bar === null || article === null) {
      return;
    }

    let frame = 0;
    const draw = () => {
      frame = 0;
      const start = article.offsetTop;
      const run = article.offsetHeight - window.innerHeight * 0.5;
      const through = run <= 0 ? 1 : (window.scrollY - start) / run;
      bar.style.transform = `scaleX(${Math.min(1, Math.max(0, through))})`;
    };
    const onScroll = () => {
      if (frame === 0) {
        frame = requestAnimationFrame(draw);
      }
    };

    draw();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame !== 0) {
        cancelAnimationFrame(frame);
      }
    };
  }, []);

  return (
    <div aria-hidden className="pointer-events-none fixed inset-x-0 top-0 z-50 h-[2px]">
      <div ref={line} className="h-full origin-left scale-x-0 bg-accent" />
    </div>
  );
}
