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
  /** The stated beat, 0 on every cut of the film that does not carry one. */
  stated: 0,
  shared: 0,
  verified: 0,
  trusted: 0,
  offer: 0,
  close: 0,
};

/**
 * Where the focal plate's lower edge is on screen, in the renderer's own
 * coordinates, for the one overlay that has to sit on it.
 *
 * The register's rule is drawn in the document rather than in the scene, so the
 * four marks stay the same shapes the consent card draws and the dates stay
 * real text at any pixel density. That leaves it needing the plate's position
 * every frame, which is the trick the captions already use: the scene writes
 * plain numbers from inside its render loop and the overlay reads them from its
 * own frame. Only the cut that carries the stated beat asks the scene for it.
 */
export const plateEdge = {
  /** True once the picture is really on the plate: nothing is written along a plate that is not there. */
  shown: false,
  leftX: 0,
  leftY: 0,
  rightX: 0,
  rightY: 0,
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

/**
 * Where the page stands against the film, written once per change by the film's
 * own frame in LandingStory.tsx.
 *
 * `ended` is the last beat read, which is when the footer exists at all.
 * `past` is the page scrolled down below the film, which is when a gesture over
 * what is left of it belongs to the page rather than to the story.
 */
export const film = { ended: false, past: false };

/** How far into its own scroller the film has been wound, and what is under it. */
export interface StoryView {
  top: number;
  /** The furthest that scroller goes. */
  max: number;
  /** One screen of the page under the film. */
  height: number;
  /** How far the page has been scrolled below the film, 0 while the film fills the window. */
  pageTop: number;
}

/** Where a key wants something to go: a distance, or one of the two ends. */
export type Move = { by: number } | { to: "start" | "end" };

export interface Reach {
  /** The film's own scroller, or null to leave it where it is. */
  story: Move | null;
  /** The page under the film, or null. */
  page: Move | null;
}

/** A beat divided into nudges, which is what an arrow key is worth. */
const NUDGES = 6;

/**
 * What one key press asks for, as a document would answer it.
 *
 * Page and Space move a beat, the arrows a nudge, Home and End the two ends.
 * Once the film has been read to its end the same keys move the page under it,
 * which is the only way a reader on a keyboard reaches the footer. Anything
 * else returns null and is left to the browser, Tab above all.
 *
 * `pages` is the cut's own page count, handed in by whoever is playing it: a
 * step is one screen of travel, and a cut with a beat more in it has a screen
 * more to divide. A key that moved a ninth of a ten page film would stop half
 * way into every beat.
 */
export function keyReach(key: string, shift: boolean, view: StoryView, pages: number): Reach | null {
  if (key === "Home") {
    return { story: { to: "start" }, page: { to: "start" } };
  }
  if (key === "End") {
    return { story: { to: "end" }, page: { to: "end" } };
  }

  const space = key === " " || key === "Spacebar";
  const travel = Math.max(1, pages - 1);
  const beat = view.max > 0 ? view.max / travel : 0;
  if (key === "PageDown" || (space && !shift)) {
    return along(true, beat, view.height, view);
  }
  if (key === "PageUp" || (space && shift)) {
    return along(false, beat, view.height, view);
  }
  if (key === "ArrowDown" || key === "ArrowUp") {
    return along(key === "ArrowDown", beat / NUDGES, view.height / NUDGES, view);
  }
  return null;
}

/**
 * One step of the story, or one of the page under it.
 *
 * The page only moves once the film has run out of story to give, and on the
 * way back it moves first: a reader who has gone past the film and turns round
 * gets the last beat back before the story rewinds a frame of it.
 */
function along(forward: boolean, story: number, page: number, view: StoryView): Reach {
  if (forward) {
    return view.top < view.max - 1 ? { story: { by: story }, page: null } : { story: null, page: { by: page } };
  }
  return view.pageTop > 0 ? { story: null, page: { by: -page } } : { story: { by: -story }, page: null };
}

/** Winds the film's own scroller, which is the one place the story's progress comes from. */
export function moveStory(el: HTMLElement, move: Move) {
  el.scrollTop = "by" in move ? el.scrollTop + move.by : move.to === "end" ? el.scrollHeight - el.clientHeight : 0;
}

let pageFrame = 0;

/**
 * Runs an action once the page has somewhere to scroll to, and drops it if it
 * never does.
 *
 * The footer is held back until the last beat has been read, and the story's
 * own damping takes about eight tenths of a second to arrive there after the
 * scroller reaches its end. So a key pressed at the end asks for room the page
 * does not have yet, and waiting for it is the difference between End reaching
 * the footer and End doing nothing. The wait is counted in milliseconds and not
 * in frames: a browser with the frame rate off its leash runs hundreds of
 * frames in that second, which spent a frame budget before the footer existed.
 */
export function whenRoom(action: (room: number) => void, within = 3000) {
  cancelAnimationFrame(pageFrame);
  const deadline = performance.now() + within;
  const step = () => {
    const room = document.documentElement.scrollHeight - window.innerHeight;
    if (room > 0) {
      action(room);
      return;
    }
    if (performance.now() < deadline) {
      pageFrame = requestAnimationFrame(step);
    }
  };
  step();
}

/** Moves the page under the film, smoothly, once there is a page to move. */
export function movePage(move: Move) {
  const back = "by" in move ? move.by < 0 : move.to === "start";
  if (back && window.scrollY <= 0) {
    return;
  }
  whenRoom((room) => {
    const to = "by" in move ? window.scrollY + move.by : move.to === "end" ? room : 0;
    window.scrollTo({ top: Math.max(0, Math.min(room, to)), behavior: "smooth" });
  });
}

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
 *
 * Once the page has gone past the film they hand nothing on: at that point a
 * gesture is a reader coming back up, and the page is the thing that has to
 * move.
 */
export function forwardWheel(event: { deltaY: number; target: EventTarget | null }) {
  if (scroller.el !== null && !film.past && !alreadyScrolling(event.target)) {
    scroller.el.scrollTop += event.deltaY;
  }
}

interface TouchLike {
  target: EventTarget | null;
  touches: { length: number; [index: number]: { clientY: number } };
}

/**
 * A drag that begins while the page is past the film carries the page back, and
 * it carries it for the whole of the drag. The decision is taken here, once,
 * the way the browser latches a gesture to one scroller: the page reaches its
 * top part way through such a drag, and without the latch the rest of the same
 * drag would rewind the story under the reader's thumb.
 */
export function forwardTouchStart(event: TouchLike) {
  lastTouchY =
    event.touches.length === 0 || film.past || alreadyScrolling(event.target) ? null : event.touches[0].clientY;
}

export function forwardTouchMove(event: TouchLike) {
  if (event.touches.length === 0 || lastTouchY === null || scroller.el === null) {
    return;
  }
  const y = event.touches[0].clientY;
  scroller.el.scrollTop += lastTouchY - y;
  lastTouchY = y;
}
