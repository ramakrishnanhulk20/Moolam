"use client";

import { useEffect, type RefObject } from "react";

const STOPS = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Where Tab goes next inside a panel that holds the keyboard.
 *
 * Returns the index of the stop to focus, or null when the browser's own move
 * is already right. From outside the panel, which is where a click on empty
 * space leaves focus, the next Tab lands on the first stop and Shift Tab on
 * the last, so the page behind is never reached.
 */
export function heldTabTarget(count: number, current: number, backwards: boolean): number | null {
  if (count === 0) {
    return null;
  }
  if (current === -1) {
    return backwards ? count - 1 : 0;
  }
  if (backwards && current === 0) {
    return count - 1;
  }
  if (!backwards && current === count - 1) {
    return 0;
  }
  return null;
}

/**
 * Holds the keyboard inside an open panel: focus moves to its first control,
 * Tab and Shift Tab cycle through its controls, Escape closes it, and when it
 * closes focus goes back to where the reader was, which is the button that
 * opened it unless a shortcut did. onClose must keep one identity across
 * renders, or the panel lets go and takes hold again on every render.
 *
 * The docs diagram viewer already behaved this way; the contents drawer and the
 * search box left focus on the page behind them.
 */
export function useHeldFocus({
  open,
  panel,
  opener,
  onClose,
}: {
  open: boolean;
  panel: RefObject<HTMLElement | null>;
  opener: RefObject<HTMLElement | null>;
  onClose: () => void;
}): void {
  useEffect(() => {
    if (!open) {
      return;
    }
    // Captured as the panel opens. A control inside the panel that focused
    // itself on the way in does not count as where the reader was.
    const was = document.activeElement;
    const before = panel.current !== null && was !== null && panel.current.contains(was) ? null : was;
    const fallback = opener.current;
    if (panel.current !== null && !panel.current.contains(document.activeElement)) {
      panel.current.querySelector<HTMLElement>(STOPS)?.focus();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      const box = panel.current;
      if (event.key !== "Tab" || box === null) {
        return;
      }
      const stops = [...box.querySelectorAll<HTMLElement>(STOPS)];
      const current = stops.findIndex((stop) => stop === document.activeElement);
      const inside = document.activeElement !== null && box.contains(document.activeElement);
      const target = heldTabTarget(stops.length, inside ? current : -1, event.shiftKey);
      if (target === null && stops.length === 0) {
        event.preventDefault();
      } else if (target !== null) {
        event.preventDefault();
        stops[target].focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      // Ctrl K opens search from anywhere, so the reader goes back to the spot
      // they left rather than to the top of the page. A press on the opener,
      // which Safari does not focus, lands back on the opener. No scroll: a
      // result on the same page has just moved the reader to its heading.
      const back =
        before instanceof HTMLElement && before !== document.body && before.isConnected ? before : fallback;
      back?.focus({ preventScroll: true });
    };
  }, [open, panel, opener, onClose]);
}
