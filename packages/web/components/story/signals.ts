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
  /** The terms beat, 0 on every cut of the film that does not carry one. */
  stated: 0,
  /** The asked beat's question and answer typing on, 0 to 1. */
  asked: 0,
  /** The found beat's traveller on its way home: 1 the moment it lands. */
  verified: 0,
  /** The look-alike beat's rail drawing, 0 to 1. */
  lookalike: 0,
  /** The waiting beat's tag turning over, 0 to 1. */
  waiting: 0,
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

/**
 * Forget where the plate was.
 *
 * These are plain numbers the scene writes and the rule reads from its own
 * frame, so nothing tells the rule that the plate has gone. A cut without the
 * stated beat, a scene taken down for the still page, or a reader who has
 * scrolled the film away would otherwise leave `shown` standing at true, and
 * the rule would be drawn along the last place a plate stood.
 */
export function resetPlateEdge() {
  plateEdge.shown = false;
  plateEdge.leftX = 0;
  plateEdge.leftY = 0;
  plateEdge.rightX = 0;
  plateEdge.rightY = 0;
}

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

/**
 * Where the film's pinned stage stands against the window.
 *
 * "coming" is the page above it still on screen, "here" is the stage pinned and
 * filling the window, "gone" is the stage scrolled away up the page after the
 * film. `top` is the stage's own top edge against the window's.
 */
export function filmPlace(top: number): "coming" | "here" | "gone" {
  if (top < -1) {
    return "gone";
  }
  return top <= 1 ? "here" : "coming";
}

/**
 * The share of the window the film has to cover before its opening plays.
 *
 * The film is mounted on the first scroll, while it is still a screen below the
 * first screen, so an entrance started on mount had played out before anybody
 * could see it. The opening words sit in the middle of the film on a laptop and
 * under the shot on a phone, so they are on the screen once most of the film is.
 */
export const OPENING_AT = 0.6;

/**
 * Whether the film has come into view far enough for its opening to play, from
 * its top edge against the window's height. A film scrolled past its top has
 * arrived too: a reader who lands below it has already come through it.
 */
export function filmArrived(top: number, room: number): boolean {
  return room > 0 && top <= room * (1 - OPENING_AT);
}
