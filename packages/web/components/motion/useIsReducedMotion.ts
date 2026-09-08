"use client";

import { useCallback, useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Whether this visitor has asked their system for less motion.
 *
 * Read through useSyncExternalStore rather than an effect, so React uses the
 * server answer for the render it is hydrating and swaps to the real one
 * straight after. A component that branched on the real answer during hydration
 * would render a different tree than the HTML it is hydrating, and React would
 * throw the whole subtree away.
 */
export function useIsReducedMotion(): boolean {
  const subscribe = useCallback((notify: () => void) => {
    const query = window.matchMedia(QUERY);
    query.addEventListener("change", notify);
    return () => query.removeEventListener("change", notify);
  }, []);

  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
}
