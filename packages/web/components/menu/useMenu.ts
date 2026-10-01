"use client";

import { useEffect, useReducer, useRef, type FocusEvent, type KeyboardEvent, type PointerEvent } from "react";
import { usePathname } from "@/lib/i18n/routing";
import { CLOSED, HASHES, SIDES, menuReducer, type MenuState, type Side } from "./menu";

/** How long the pointer rests on a side before it opens, so a pointer crossing the bar opens nothing. */
export const HOVER_OPEN_MS = 160;
/** How long the pointer may be away before a side it opened closes, so a diagonal path to a tile survives. */
export const HOVER_CLOSE_MS = 280;

const LINK = "[data-menu-link]";

/** The next link to focus for an arrow key, or null for a key the menu does not move on. */
export function stepLink(from: number, key: string, count: number): number | null {
  if (count === 0) {
    return null;
  }
  switch (key) {
    case "ArrowDown":
    case "ArrowRight":
      return from < 0 ? 0 : (from + 1) % count;
    case "ArrowUp":
    case "ArrowLeft":
      return from < 0 ? count - 1 : (from - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** Scrolls a section of the page in under the header, if the page has it. */
export function landOn(id: string): void {
  const target = document.getElementById(id);
  if (target === null) {
    return;
  }
  const header = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--header-h")) || 0;
  window.scrollTo({ top: target.getBoundingClientRect().top + window.scrollY - header, behavior: "instant" });
}

/** Runs after two frames, past the reset a new route gets, and hands back the cancel. */
function afterTwoFrames(run: () => void): () => void {
  let frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(run);
  });
  return () => cancelAnimationFrame(frame);
}

/**
 * Lands on the part of a page the menu pointed at, once the page has arrived.
 *
 * Smooth scrolling puts every new page back at its top (LenisProvider), which
 * runs after the browser has already jumped to the fragment, so Pricing
 * pressed on any other page opened the business page at its first screen.
 * This waits two frames, past that reset, and scrolls the section in under
 * the header. It acts only on the fragments the menu itself links to.
 */
export function useLandOnHash() {
  const route = usePathname();
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    return HASHES.includes(id) ? afterTwoFrames(() => landOn(id)) : undefined;
  }, [route]);
}

/**
 * The same landing for a press on a fragment link while its page is already
 * open, where the route does not change and, with the fragment already in the
 * address, the router does not scroll either.
 */
export function landAfterPress(href: string): void {
  const id = href.split("#")[1];
  if (id !== undefined && HASHES.includes(id)) {
    afterTwoFrames(() => landOn(id));
  }
}

/**
 * The laptop menu's wiring: the shared rule book plus the timers and the
 * document listeners a rule book cannot hold.
 */
export function useMenu(initial: MenuState = CLOSED) {
  const [state, dispatch] = useReducer(menuReducer, initial);
  const root = useRef<HTMLDivElement>(null);
  const triggers = useRef<Partial<Record<Side, HTMLButtonElement | null>>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusFirst = useRef(false);
  const route = usePathname();
  const lastRoute = useRef(route);

  const clearTimer = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  useEffect(() => clearTimer, []);

  useEffect(() => {
    if (lastRoute.current !== route) {
      lastRoute.current = route;
      dispatch({ type: "route" });
    }
  }, [route]);

  useEffect(() => {
    if (state.open === null) {
      return;
    }
    const onPointer = (event: globalThis.PointerEvent) => {
      if (root.current !== null && !root.current.contains(event.target as Node)) {
        dispatch({ type: "outside" });
      }
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      const side = state.open;
      const hadFocus = root.current?.contains(document.activeElement) ?? false;
      dispatch({ type: "key", key: "Escape" });
      if (hadFocus && side !== null) {
        triggers.current[side]?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [state.open]);

  // The open side's links are found by asking the bar for that side, not
  // through a ref on the panel: a side that is still sliding out stays in the
  // page for a moment, and its links must never take the focus.
  const firstLink = (side: Side) =>
    root.current?.querySelector<HTMLElement>(`[data-menu-side="${side}"] ${LINK}`) ?? null;

  useEffect(() => {
    if (state.open !== null && focusFirst.current) {
      focusFirst.current = false;
      firstLink(state.open)?.focus();
    }
  }, [state.open]);

  const triggerProps = (side: Side) => ({
      ref: (node: HTMLButtonElement | null) => {
        triggers.current[side] = node;
      },
      type: "button" as const,
      "aria-expanded": state.open === side,
      "aria-controls": `menu-${side}`,
      onClick: () => {
        clearTimer();
        dispatch({ type: "press", side });
      },
      onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
        // The panel comes after the whole bar in the page, so Tab from an open
        // side would skip its tiles; it is sent into them instead.
        if (event.key === "Tab" && !event.shiftKey && state.open === side) {
          const first = firstLink(side);
          if (first !== null) {
            event.preventDefault();
            first.focus();
          }
          return;
        }
        if (event.key === "ArrowDown") {
          event.preventDefault();
          focusFirst.current = true;
          dispatch({ type: "key", key: "ArrowDown", side });
          if (state.open === side) {
            focusFirst.current = false;
            firstLink(side)?.focus();
          }
        }
      },
      onPointerEnter: (event: PointerEvent<HTMLButtonElement>) => {
        if (event.pointerType !== "mouse") {
          return;
        }
        clearTimer();
        if (state.open !== null) {
          dispatch({ type: "hover", side });
          return;
        }
        timer.current = setTimeout(() => dispatch({ type: "hover", side }), HOVER_OPEN_MS);
      },
  });

  const rootProps = {
    ref: root,
    onPointerEnter: (event: PointerEvent<HTMLDivElement>) => {
      if (event.pointerType === "mouse" && state.open !== null) {
        clearTimer();
      }
    },
    onPointerLeave: (event: PointerEvent<HTMLDivElement>) => {
      if (event.pointerType !== "mouse") {
        return;
      }
      clearTimer();
      timer.current = setTimeout(() => dispatch({ type: "leave" }), HOVER_CLOSE_MS);
    },
    // Focus that moves on to the account or the chips, still inside the bar,
    // has left the menu all the same.
    onFocus: (event: FocusEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      if (state.open !== null && target.closest("[data-menu-trigger], [data-menu-panel]") === null) {
        dispatch({ type: "focusout" });
      }
    },
    onBlur: (event: FocusEvent<HTMLDivElement>) => {
      // A null target is the window losing focus, or a press on something that
      // takes none; the outside press rule answers the second, and the first
      // should leave the menu as it was.
      const next = event.relatedTarget as Node | null;
      if (next !== null && !event.currentTarget.contains(next)) {
        dispatch({ type: "focusout" });
      }
    },
  };

  const panelProps = {
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
      const side = state.open;
      const links = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(`[data-menu-side="${side}"] ${LINK}`));
      if (event.key === "Tab" && side !== null) {
        const at = links.indexOf(document.activeElement as HTMLElement);
        // Out of the first tile backwards is the side's own trigger; out of
        // the last forwards is the next side's, or on past the menu.
        const back = event.shiftKey && at === 0 ? triggers.current[side] : null;
        const after = SIDES[SIDES.indexOf(side) + 1];
        const on = !event.shiftKey && at === links.length - 1 && after !== undefined ? triggers.current[after] : null;
        const target = back ?? on;
        if (target) {
          event.preventDefault();
          target.focus();
        }
        return;
      }
      const next = stepLink(links.indexOf(document.activeElement as HTMLElement), event.key, links.length);
      if (next !== null) {
        event.preventDefault();
        links[next].focus();
      }
    },
  };

  return { state, dispatch, triggerProps, rootProps, panelProps };
}
