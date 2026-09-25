/**
 * The one table the whole story runs on, in the two cuts it has.
 *
 * Every offset below is a fraction of the total scroll. The camera path, the
 * scene's own state switches and the caption layer are all read from this
 * table, so a caption cannot arrive while the camera is still on the way to the
 * plate it is talking about: a caption starts at the exact offset its beat
 * starts, and it has left again before the next beat starts. The gap between
 * one caption ending and the next beat starting is the travel, and nothing is
 * being read during it.
 *
 * The classic cut is the film Ram approved, to the last offset. The stated cut
 * is the same film with one more beat in it, the holder's word on AI use. The
 * home page's chapter plays the stated cut and falls back to the classic one
 * on a day with no statement to draw, so both tables stay. The film is handed
 * the cut it is playing rather than reading a table out of this module.
 */

/** The two tables the film can be timed by. */
export type BeatCut = "classic" | "stated";

/**
 * What the home page asks the film to play: the film told as a chapter under
 * the first screen. It opens on a chapter title and its last card is the
 * page's one final call. Its beats, offsets and camera are the stated cut's,
 * or the classic cut's on a day with no statement to draw.
 */
export type StoryVariant = "chapter";

/** Every beat the film can carry. "stated" belongs to the stated cut alone. */
export type BeatName =
  | "opening"
  | "made"
  | "sealed"
  | "stated"
  | "shared"
  | "verified"
  | "trusted"
  | "offer"
  | "close";

/** The eight beats both cuts carry, whatever else is in the table. */
export type ClassicBeatName = Exclude<BeatName, "stated">;

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

/** Screens of scroll drei's ScrollControls hands the scene. Nine pages, eight screens of travel. */
const CLASSIC_PAGES = 9;

/** The stated cut adds exactly one screen, for the one new beat. */
const STATED_SCREENS = 1;

/** How much scroll a caption takes to fade in, and to fade out again, in the classic cut. */
export const CAPTION_FADE = 0.016;

/**
 * How much of the new beat its caption is on screen for. It is the sealed
 * beat's own share, so what is left for the camera to travel out on is the
 * travel the film already has between two close shots.
 */
const STATED_CAPTION_SHARE = 0.66;

/** How far a caption sits below its resting place before it has arrived, in pixels. */
const CAPTION_RISE = 26;

const CLASSIC_BEATS: Beat[] = [
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

/**
 * The new beat, between the seal and the copies leaving.
 *
 * The camera swings round to the other side of the plate and drops to its lower
 * edge, which is where the register draws itself along the picture. The plate
 * takes the left of the frame, so the words take the right.
 */
function statedBeat(start: number, room: number): Beat {
  return {
    name: "stated",
    start,
    end: start + room,
    captionStart: start,
    captionEnd: start + room * STATED_CAPTION_SHARE,
    align: "end",
    // Close enough to cut the top of the picture off, with its lower edge about
    // two thirds down the frame and the dark right of the shot left to the
    // words. The drift pushes in a little further and lifts the edge with it.
    arrive: { pos: [-0.44, -0.26, 2.86], look: [0.64, -0.52, 0] },
    settle: { pos: [-0.3, -0.32, 2.66], look: [0.56, -0.46, 0] },
  };
}

/**
 * The classic beats with one screen made for the new one.
 *
 * Every existing beat keeps the number of screens it has today: the film is a
 * screen longer, so each old offset is squeezed by exactly that screen, and
 * everything after the seal is pushed along by it. The two ends stay the two
 * ends, which is what keeps the last caption held to the end of the scroll.
 */
function statedBeats(): Beat[] {
  const travel = CLASSIC_PAGES - 1;
  const wider = travel + STATED_SCREENS;
  const squeeze = travel / wider;
  const room = STATED_SCREENS / wider;
  const seal = CLASSIC_BEATS.findIndex((beat) => beat.name === "sealed");

  const moved = (value: number, after: boolean) =>
    value === 0 || value === 1 ? value : value * squeeze + (after ? room : 0);

  const out: Beat[] = [];
  CLASSIC_BEATS.forEach((beat, at) => {
    const after = at > seal;
    out.push({
      ...beat,
      start: moved(beat.start, after),
      end: moved(beat.end, after),
      captionStart: moved(beat.captionStart, after),
      captionEnd: moved(beat.captionEnd, after),
    });
    if (at === seal) {
      out.push(statedBeat(moved(beat.end, false), room));
    }
  });
  return out;
}

/** One cut of the film: its pages, its beats, and the camera path they make. */
export interface BeatTable {
  variant: BeatCut;
  pages: number;
  /** A caption's fade, in this cut's own fractions, so it is the same scroll distance in both. */
  fade: number;
  beats: Beat[];
  /** Every beat this cut carries, by name. A cut without the stated beat simply has no key for it. */
  beat: Partial<Record<BeatName, Beat>> & Record<ClassicBeatName, Beat>;
  /**
   * The camera path, straight out of the table: every beat contributes the pose
   * it has arrived at when its caption starts and the pose it has drifted to
   * when the caption is gone. All the travelling therefore happens between one
   * caption leaving and the next arriving.
   */
  cameraKeys: { at: number; pose: Pose }[];
}

function tableOf(variant: BeatCut): BeatTable {
  const beats = variant === "stated" ? statedBeats() : CLASSIC_BEATS;
  const pages = variant === "stated" ? CLASSIC_PAGES + STATED_SCREENS : CLASSIC_PAGES;

  return {
    variant,
    pages,
    fade: (CAPTION_FADE * (CLASSIC_PAGES - 1)) / (pages - 1),
    beats,
    beat: Object.fromEntries(beats.map((entry) => [entry.name, entry])) as BeatTable["beat"],
    cameraKeys: beats.flatMap((entry) => [
      { at: entry.start, pose: entry.arrive },
      { at: entry.captionEnd, pose: entry.settle },
    ]),
  };
}

/** Both cuts, built once: a screen holding one of these holds the same object all the way through. */
const TABLES: Record<BeatCut, BeatTable> = {
  classic: tableOf("classic"),
  stated: tableOf("stated"),
};

export function beatTable(cut: BeatCut): BeatTable {
  return TABLES[cut];
}

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
export function captionCue(t: number, beat: Beat, fade: number): { shown: number; y: number } {
  // The first beat is already on screen when the page loads, and its entrance is
  // the one that runs on load rather than on scroll.
  const entered = beat.captionStart <= 0 ? 1 : span(t, beat.captionStart, beat.captionStart + fade);
  // The last beat holds to the end of the scroll: nothing follows it to make room for.
  const left = beat.captionEnd >= 1 ? 0 : span(t, beat.captionEnd - fade, beat.captionEnd);

  return { shown: entered * (1 - left), y: (1 - entered) * CAPTION_RISE - left * CAPTION_RISE };
}
