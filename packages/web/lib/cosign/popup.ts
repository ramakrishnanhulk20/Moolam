import { useEffect, useState, useSyncExternalStore } from "react";
import type { CosignModel } from "./flow";
import { currentOpener } from "./opener";

/**
 * When a platform opens the co-sign or connect page in a small window, the
 * page draws itself as a checkout and shuts itself when the job is done. Both
 * pages still refuse to be framed (P10): the window is always Moolam's own,
 * with Moolam's own address in its bar, so a platform can never draw a copy.
 *
 * All of this only changes the layout. What is checked, drawn and signed is
 * the same on either layout, because both read the same model and press the
 * same handlers.
 */

/** The widest viewport still drawn as a checkout. A phone is under it, so a popup a phone opened as a tab counts too. */
export const CHECKOUT_MAX_WIDTH = 560;

/** How long the done line stays up before the window shuts, long enough to read and short enough not to wait on. */
export const CLOSE_AFTER_MS = 1_500;

/** How long after asking to close the page decides the browser said no. */
export const STUCK_AFTER_MS = 400;

/** A checkout needs both: a window that opened this one, and a small viewport. Either alone is the full page. */
export function inCheckoutWindow({ hasOpener, width }: { hasOpener: boolean; width: number }): boolean {
  return hasOpener && width > 0 && width <= CHECKOUT_MAX_WIDTH;
}

function subscribe(notify: () => void): () => void {
  window.addEventListener("resize", notify);
  return () => window.removeEventListener("resize", notify);
}

function checkoutSnapshot(): boolean {
  return inCheckoutWindow({ hasOpener: currentOpener() !== null, width: window.innerWidth });
}

/**
 * Whether this page is in a checkout window. False on the server and for the
 * render being hydrated, so both paint the same full page; the browser
 * answers straight after, and again whenever the window is resized.
 */
export function useCheckoutWindow(): boolean {
  return useSyncExternalStore(subscribe, checkoutSnapshot, () => false);
}

/** The part of a window the close uses. */
export interface ClosingWindow {
  opener: unknown;
  closed: boolean;
  close: () => void;
}

/**
 * Only a window a script opened may shut itself: a browser ignores close()
 * on a tab the person opened, and the opener is the sign a script did it.
 */
export function openedByScript(win: ClosingWindow): boolean {
  return win.opener !== null && win.opener !== undefined && win.opener !== win;
}

export interface Timers {
  set: (run: () => void, ms: number) => unknown;
  clear: (id: unknown) => void;
}

const REAL_TIMERS: Timers = {
  set: (run, ms) => window.setTimeout(run, ms),
  clear: (id) => window.clearTimeout(id as number),
};

/**
 * Shuts a finished checkout window after the done line has been read. Runs
 * only once the page's own message to the opener has gone out (`sent`), and
 * only for a window a script opened. When the browser keeps the window open
 * anyway, `onStuck` tells the page to offer its own close button. Returns a
 * cancel for a page that unmounts first.
 */
export function closeWhenDone(win: ClosingWindow, sent: boolean, onStuck: () => void, timers: Timers = REAL_TIMERS): () => void {
  if (!sent || !openedByScript(win)) {
    return () => undefined;
  }
  let stuck: unknown = null;
  const closing = timers.set(() => {
    win.close();
    stuck = timers.set(() => {
      if (!win.closed) onStuck();
    }, STUCK_AFTER_MS);
  }, CLOSE_AFTER_MS);
  return () => {
    timers.clear(closing);
    if (stuck !== null) timers.clear(stuck);
  };
}

/**
 * Whether a co-sign checkout has nothing left to do: the passport's receipt
 * is in, the page has told the opener (`reported`), and the AI-use terms are
 * written, already stated, or were never carried. Terms still going out, or
 * waiting on the person's press after a failure, keep the window open, since
 * shutting it would drop the second transaction.
 */
export function cosignFinished(model: Pick<CosignModel, "view" | "send" | "terms">, reported: boolean): boolean {
  if (!reported || model.view !== "registered" || model.send.at !== "registered") return false;
  return model.terms.at === "none" || model.terms.at === "written" || model.terms.at === "stated";
}

/** Where a finished checkout is: not done, shutting itself, or kept open by the browser. */
export type Closing = "idle" | "closing" | "stuck";

/**
 * Drives the close on a checkout page. `done` must be true only after the
 * message to the opener went out; a page that is not a checkout never closes.
 */
export function useCloseWhenDone(checkout: boolean, done: boolean): Closing {
  const [stuck, setStuck] = useState(false);
  const active = checkout && done;

  useEffect(() => {
    if (!active) return;
    return closeWhenDone(window as unknown as ClosingWindow, true, () => setStuck(true));
  }, [active]);

  if (!active) return "idle";
  return stuck ? "stuck" : "closing";
}

/** The person's own press on "Close this window", for a browser that did not let the page do it. */
export function closeThisWindow(): void {
  window.close();
}
