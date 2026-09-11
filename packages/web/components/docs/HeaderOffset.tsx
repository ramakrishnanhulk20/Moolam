"use client";

import { useEffect } from "react";

/**
 * Publishes the height of the app header as a CSS variable.
 *
 * The sidebar and the contents list stick under that header, and the header
 * changes height when it wraps on a narrow window, so the number is measured
 * rather than guessed. Nothing re-renders: the value goes straight onto the
 * document as --docs-top.
 */
export function HeaderOffset() {
  useEffect(() => {
    const header = document.querySelector(".app-header");
    if (header === null) {
      return;
    }
    const publish = () => {
      document.documentElement.style.setProperty("--docs-top", `${Math.round(header.getBoundingClientRect().height)}px`);
    };
    publish();
    const watcher = new ResizeObserver(publish);
    watcher.observe(header);
    return () => {
      watcher.disconnect();
      document.documentElement.style.removeProperty("--docs-top");
    };
  }, []);

  return null;
}
