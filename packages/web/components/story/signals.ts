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
 * Whether the browser is already scrolling the story with this gesture.
 *
 * The scene's scroll element takes a wheel or a drag over itself natively.
 * Forwarding one of those as well would move the story twice as far.
 */
function alreadyScrolling(target: EventTarget | null): boolean {
  return scroller.el !== null && target !== null && scroller.el.contains(target as Node);
}

/**
 * Hands a gesture over the pinned film back to the story's own scroller.
 *
 * The scroller covers the whole pinned screen, and the captions over it let a
 * touch through, so most of the film is scrolled by the browser itself. Two
 * panels take their own taps though, the drop panel and the closing card, and a
 * gesture that starts on one of those reaches no scrollable element at all.
 * These pass the movement on, from the film wrapper, so every part of the
 * pinned screen carries the story.
 */
export function forwardWheel(event: { deltaY: number; target: EventTarget | null }) {
  if (scroller.el !== null && !alreadyScrolling(event.target)) {
    scroller.el.scrollTop += event.deltaY;
  }
}

interface TouchLike {
  target: EventTarget | null;
  touches: { length: number; [index: number]: { clientY: number } };
}

export function forwardTouchStart(event: TouchLike) {
  lastTouchY = event.touches.length === 0 || alreadyScrolling(event.target) ? null : event.touches[0].clientY;
}

export function forwardTouchMove(event: TouchLike) {
  if (event.touches.length === 0 || lastTouchY === null || scroller.el === null) {
    return;
  }
  const y = event.touches[0].clientY;
  scroller.el.scrollTop += lastTouchY - y;
  lastTouchY = y;
}
