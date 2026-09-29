"use client";

import { useEffect } from "react";

type Measurable = { getBoundingClientRect(): { height: number } };

/**
 * The height of the first header that is actually on screen.
 *
 * The layout renders two headers with the app-header class, a phone one and a
 * laptop one, and CSS hides whichever does not fit the window. A hidden header
 * measures 0, so the first one with any height is the one the reader sees.
 */
export function shownHeaderHeight(headers: ArrayLike<Measurable>): number {
  for (let i = 0; i < headers.length; i += 1) {
    const height = Math.round(headers[i].getBoundingClientRect().height);
    if (height > 0) {
      return height;
    }
  }
  return 0;
}

/**
 * Publishes the height of the shown app header as a CSS variable.
 *
 * The sidebar and the contents list stick under that header, and the header
 * changes height when it wraps on a narrow window or swaps for the phone one,
 * so the number is measured rather than guessed. Nothing re-renders: the value
 * goes straight onto the document as --docs-top.
 */
export function HeaderOffset() {
  useEffect(() => {
    const headers = document.querySelectorAll<HTMLElement>(".app-header");
    if (headers.length === 0) {
      return;
    }
    const publish = () => {
      document.documentElement.style.setProperty("--docs-top", `${shownHeaderHeight(headers)}px`);
    };
    publish();
    const watcher = new ResizeObserver(publish);
    headers.forEach((header) => watcher.observe(header));
    // Crossing the 768 px line hides one header and shows the other; the
    // observer sees that too, but a window resize is the cheap backstop.
    window.addEventListener("resize", publish);
    return () => {
      watcher.disconnect();
      window.removeEventListener("resize", publish);
      document.documentElement.style.removeProperty("--docs-top");
    };
  }, []);

  return null;
}
