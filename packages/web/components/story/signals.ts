/**
 * Scroll position and the verify answer, published as plain mutable numbers.
 *
 * The scene writes these inside its render loop and the readouts over it read
 * them from their own animation frame. Putting any of it in React state would
 * mean re-rendering the page sixty times a second against the same frame
 * budget the camera is using.
 */
export const progress = {
  /** 0 to 1 across the whole story. */
  scroll: 0,
  made: 0,
  sealed: 0,
  shared: 0,
  verified: 0,
  trusted: 0,
  offer: 0,
  close: 0,
};

export type ProbeState = "idle" | "pending" | "matched" | "refused";

/** The visitor's own upload, written by the drop panel and read by the plate. */
export const probe: { state: ProbeState; confidence: number } = {
  state: "idle",
  confidence: 0,
};

export function resetProbe() {
  probe.state = "idle";
  probe.confidence = 0;
}

/** The element drei's ScrollControls actually scrolls, published once it exists. */
export const scroller: { el: HTMLElement | null } = { el: null };

let lastTouchY: number | null = null;

/**
 * Hands a gesture over a pinned panel back to the story's own scroller.
 *
 * The panels sit beside the canvas rather than inside it, so a wheel over one
 * of them reaches no scrollable element at all and the story simply stops
 * moving under the reader's hand. This passes the movement on.
 */
export function forwardWheel(event: { deltaY: number }) {
  if (scroller.el !== null) {
    scroller.el.scrollTop += event.deltaY;
  }
}

interface TouchLike {
  touches: { length: number; [index: number]: { clientY: number } };
}

export function forwardTouchStart(event: TouchLike) {
  lastTouchY = event.touches.length === 0 ? null : event.touches[0].clientY;
}

export function forwardTouchMove(event: TouchLike) {
  if (event.touches.length === 0 || lastTouchY === null || scroller.el === null) {
    return;
  }
  const y = event.touches[0].clientY;
  scroller.el.scrollTop += lastTouchY - y;
  lastTouchY = y;
}
