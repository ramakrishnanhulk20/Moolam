/**
 * The one table the whole story runs on.
 *
 * Every offset below is a fraction of the total scroll. The camera path, the
 * scene's own state switches and the caption layer are all read from this
 * table, so a caption cannot arrive while the camera is still on the way to the
 * plate it is talking about: a caption starts at the exact offset its beat
 * starts, and it has left again before the next beat starts. The gap between
 * one caption ending and the next beat starting is the travel, and nothing is
 * being read during it.
 */

/** Screens of scroll drei's ScrollControls hands the scene. Nine pages, eight screens of travel. */
export const PAGES = 9;

/** How much scroll a caption takes to fade in, and to fade out again. */
export const CAPTION_FADE = 0.016;

/** How far a caption sits below its resting place before it has arrived, in pixels. */
const CAPTION_RISE = 26;

export type BeatName = "opening" | "made" | "sealed" | "shared" | "verified" | "trusted" | "offer" | "close";

/** Where the camera is and what it is pointed at. */
export interface Pose {
  pos: [number, number, number];
  look: [number, number, number];
}

export interface Beat {
  name: BeatName;
  /** Where the beat's scene state begins, and where its caption begins with it. */
  start: number;
  /** Where the next beat begins. */
  end: number;
  captionStart: number;
  /** The caption is gone by here, which leaves `end - captionEnd` of scroll for the camera to travel. */
  captionEnd: number;
  /** Which side of the frame the words take, so the shot leaves the other side to the scene. */
  align: "start" | "end";
  /** Where the camera has arrived by `start`, before a word of the caption is on screen. */
  arrive: Pose;
  /** Where it has drifted to by `captionEnd`. A shot that holds perfectly still reads as a photograph. */
  settle: Pose;
}

export const BEATS: Beat[] = [
  {
    name: "opening",
    start: 0,
    end: 0.112,
    captionStart: 0,
    captionEnd: 0.068,
    align: "start",
    // The whole field, the plate the story follows small and far off to the right of the title.
    arrive: { pos: [0.9, 0.35, 7.4], look: [-0.85, 0, 0] },
    settle: { pos: [0.74, 0.3, 6.55], look: [-0.8, 0, 0] },
  },
  {
    name: "made",
    start: 0.112,
    end: 0.24,
    captionStart: 0.112,
    captionEnd: 0.2,
    align: "start",
    // Close on the plate while the particles gather into the picture.
    arrive: { pos: [0.36, 0.1, 4.05], look: [-0.75, 0, 0] },
    settle: { pos: [0.3, 0.06, 3.78], look: [-0.72, 0, 0] },
  },
  {
    name: "sealed",
    start: 0.24,
    end: 0.376,
    captionStart: 0.24,
    captionEnd: 0.33,
    align: "start",
    // Swung round to the corner the seal drops into.
    arrive: { pos: [-0.55, 0.42, 3.5], look: [-1.05, 0.24, 0] },
    settle: { pos: [-0.4, 0.34, 3.34], look: [-0.95, 0.2, 0] },
  },
  {
    name: "shared",
    start: 0.376,
    end: 0.536,
    captionStart: 0.376,
    captionEnd: 0.48,
    align: "end",
    // Back and up as the copies leave, with the field on the left of the words.
    arrive: { pos: [1.3, 0.72, 6.1], look: [0.95, 0.04, -0.1] },
    settle: { pos: [2.05, 1, 7.35], look: [1.15, 0.06, -0.35] },
  },
  {
    name: "verified",
    start: 0.536,
    end: 0.692,
    captionStart: 0.536,
    // The ladder is the longest read in the film and the flight out of it used
    // to leave a screen and a half of nothing before the next words arrived.
    captionEnd: 0.668,
    align: "start",
    // The copy that comes home enters from the right and lands back on the plate.
    arrive: { pos: [-0.2, 0.85, 7], look: [-1.1, 0.7, 0.3] },
    settle: { pos: [0.3, 0.3, 4.5], look: [-0.62, 0.18, 0.15] },
  },
  {
    name: "trusted",
    start: 0.692,
    end: 0.824,
    captionStart: 0.692,
    // Same again on the way into the drop panel: the words hold almost to the
    // moment the panel arrives, so the offer never lands in an empty shot.
    captionEnd: 0.8,
    align: "end",
    // Held on the sealed plate, on the left of the standing card.
    arrive: { pos: [0.25, 0.18, 4], look: [1, 0.06, 0] },
    settle: { pos: [0.18, 0.14, 4.35], look: [0.95, 0.05, 0] },
  },
  {
    name: "offer",
    start: 0.824,
    end: 0.936,
    captionStart: 0.824,
    captionEnd: 0.912,
    align: "end",
    // The plate takes the left half and the drop panel the right.
    arrive: { pos: [-1.6, 0.3, 4.5], look: [0.85, 0.06, 0] },
    settle: { pos: [-1.45, 0.24, 4.3], look: [0.78, 0.05, 0] },
  },
  {
    name: "close",
    start: 0.936,
    end: 1,
    captionStart: 0.936,
    captionEnd: 1,
    align: "start",
    // Out, and the field comes back up: the last screen is about how many there are.
    arrive: { pos: [0.1, 0.45, 6.6], look: [-0.95, -0.1, -0.6] },
    settle: { pos: [0.58, 0.92, 8.5], look: [-0.55, -0.25, -1.6] },
  },
];

export const BEAT = Object.fromEntries(BEATS.map((entry) => [entry.name, entry])) as Record<BeatName, Beat>;

/**
 * The camera path, straight out of the table: every beat contributes the pose it
 * has arrived at when its caption starts and the pose it has drifted to when the
 * caption is gone. All the travelling therefore happens between one caption
 * leaving and the next arriving.
 */
export const CAMERA_KEYS: { at: number; pose: Pose }[] = BEATS.flatMap((entry) => [
  { at: entry.start, pose: entry.arrive },
  { at: entry.captionEnd, pose: entry.settle },
]);

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** 0 before `from`, 1 after `to`, straight line between. */
export function span(t: number, from: number, to: number): number {
  return to <= from ? (t >= to ? 1 : 0) : clamp01((t - from) / (to - from));
}

/**
 * How far a beat's own movement has run.
 *
 * `share` is how much of the caption's time on screen the movement takes: the
 * default finishes it around two thirds of the way through the reading, so the
 * change is seen happening and the result is still there to look at.
 */
export function played(t: number, beat: Beat, share = 0.62): number {
  return span(t, beat.start, beat.start + (beat.captionEnd - beat.start) * share);
}

/** A caption's opacity and how far it still has to rise, both from the table. */
export function captionCue(t: number, beat: Beat): { shown: number; y: number } {
  // The first beat is already on screen when the page loads, and its entrance is
  // the one that runs on load rather than on scroll.
  const entered = beat.captionStart <= 0 ? 1 : span(t, beat.captionStart, beat.captionStart + CAPTION_FADE);
  // The last beat holds to the end of the scroll: nothing follows it to make room for.
  const left = beat.captionEnd >= 1 ? 0 : span(t, beat.captionEnd - CAPTION_FADE, beat.captionEnd);

  return { shown: entered * (1 - left), y: (1 - entered) * CAPTION_RISE - left * CAPTION_RISE };
}
