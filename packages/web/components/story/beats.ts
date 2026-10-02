/**
 * The one table the whole story runs on.
 *
 * Every offset below is a fraction of the total scroll. The camera path, the
 * scene's own state switches and the caption layer are all read from this
 * table, so a caption cannot arrive while the camera is still on the way to the
 * print it is talking about: a caption starts at the exact offset its beat
 * starts, and it has left again before the next beat starts. The gap between
 * one caption ending and the next beat starting is the travel, and nothing is
 * being read during it.
 *
 * The film is the story-v2 script: an opening, eleven beats and a closing card.
 * The day's data decides which beats are in the cut (cut.ts), and the table is
 * built for exactly those, each taking the screens the pace table gives it, so
 * a beat left out takes its scroll with it rather than leaving a gap.
 */

import { PACE } from "@/components/story/pace";

/**
 * What the home page asks the film to play: the film told as a chapter under
 * the first screen. It opens on a chapter title and its last card is the
 * page's one final call.
 */
export type StoryVariant = "chapter";

/** Every beat the film can carry, in the order it plays them. */
export const BEAT_ORDER = [
  "opening",
  "imagined",
  "sealed",
  "stated",
  "asked",
  "shared",
  "verified",
  "checked",
  "lookalike",
  "yourself",
  "waiting",
  "offer",
  "close",
] as const;

export type BeatName = (typeof BEAT_ORDER)[number];

/** The beats every cut carries, whatever the day's data says. */
export const ALWAYS = ["opening", "sealed", "shared", "verified", "offer", "close"] as const;

export type AlwaysBeat = (typeof ALWAYS)[number];

/** Where the camera is and what it is pointed at. */
export interface Pose {
  pos: [number, number, number];
  look: [number, number, number];
}

/**
 * One camera pose inside a beat, at a share of the beat from 0 to 1. A phone
 * takes the wide pose with two corrections (LandingStory.tsx), unless the shot
 * needs its own framing on a tall screen, which is then written out whole.
 */
export interface BeatKey {
  at: number;
  pose: Pose;
  phone?: Pose;
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
  /** Poses between the two, at shares of the beat, for a beat that holds or turns on the way. */
  between: BeatKey[];
  /** Whole poses for a phone, at the arrive and settle ends, for a shot the corrections cannot frame. */
  phone?: { arrive: Pose; settle: Pose };
}

/** How much scroll a caption takes to fade in, and to fade out again, in screens. */
export const CAPTION_FADE_SCREENS = 0.128;

/** How far a caption sits below its resting place before it has arrived, in pixels. */
const CAPTION_RISE = 26;

/** Shares of the found beat: the copy is home at `snap`, and nothing moves until `holdEnd`. */
export const FOUND = { flightFrom: 0.04, snap: 0.45, holdEnd: 0.68 } as const;

/** Shares of the signed beat: the stamp falls, lands, and its ink spreads once. */
export const SIGNED = { fallFrom: 0.08, land: 0.3 } as const;

/** Shares of the look-alike beat: the later print slides in, the rail draws, the mark lands last. */
export const LOOKALIKE_STEPS = {
  slideFrom: 0.06,
  slideTo: 0.4,
  railFrom: 0.36,
  railTo: 0.66,
  markFrom: 0.62,
  markTo: 0.76,
} as const;

/** Shares of the sign-it-yourself beat: the print arrives, the press lands, the label turns into a name. */
export const YOURSELF_STEPS = { arriveTo: 0.32, pressAt: 0.42, turnTo: 0.6 } as const;

/** Shares of the checked beat: the hairline circles the print, then the mark presses in. */
export const CHECKED_STEPS = { circleFrom: 0.08, circleTo: 0.42, markFrom: 0.42, markTo: 0.56 } as const;

interface Shape {
  captionShare: number;
  align: "start" | "end";
  arrive: Pose;
  settle: Pose;
  between?: BeatKey[];
  phone?: { arrive: Pose; settle: Pose };
}

/** The shot and the words' side for every beat, the stays keeping the paths they had. */
const SHAPES: Record<BeatName, Shape> = {
  opening: {
    captionShare: 0.6,
    align: "start",
    // The whole wall, the print the story follows small and far off to the right of the title.
    arrive: { pos: [0.9, 0.35, 7.4], look: [-0.85, 0, 0] },
    settle: { pos: [0.74, 0.3, 6.55], look: [-0.8, 0, 0] },
  },
  imagined: {
    captionShare: 0.69,
    align: "start",
    // Close on the print while it inks itself into the paper.
    arrive: { pos: [0.36, 0.1, 4.05], look: [-0.75, 0, 0] },
    settle: { pos: [0.3, 0.06, 3.78], look: [-0.72, 0, 0] },
  },
  sealed: {
    captionShare: 0.74,
    align: "start",
    // Swung round to the corner the stamp comes down on, the whole print in the shot.
    arrive: { pos: [-0.42, 0.38, 3.85], look: [-0.88, 0.2, 0] },
    settle: { pos: [-0.3, 0.32, 3.65], look: [-0.82, 0.16, 0] },
  },
  stated: {
    captionShare: 0.66,
    align: "end",
    // Close enough to cut the top of the picture off, with its lower edge about
    // two thirds down the frame and the right of the shot left to the words.
    arrive: { pos: [-0.44, -0.26, 2.86], look: [0.64, -0.52, 0] },
    settle: { pos: [-0.3, -0.32, 2.66], look: [0.56, -0.46, 0] },
  },
  asked: {
    captionShare: 0.72,
    align: "end",
    // Slid right off the print's edge, so the question types in the room beside it.
    arrive: { pos: [-0.9, 0.05, 3.7], look: [0.78, 0, 0] },
    settle: { pos: [-0.8, 0.02, 3.5], look: [0.72, 0, 0] },
  },
  shared: {
    captionShare: 0.65,
    align: "end",
    // Back and up as the copies leave, with the field on the left of the words.
    arrive: { pos: [1.3, 0.72, 6.1], look: [0.95, 0.04, -0.1] },
    settle: { pos: [2.05, 1, 7.35], look: [1.15, 0.06, -0.35] },
  },
  verified: {
    captionShare: 0.86,
    align: "start",
    // Wide, so the copy is seen crossing the whole wall, then in on the print
    // as it snaps home, and held there: the scroll stops at the snap.
    arrive: { pos: [-0.2, 0.85, 7.4], look: [-1.3, 0.7, 0.3] },
    between: [
      { at: FOUND.snap, pose: { pos: [0.3, 0.3, 4.9], look: [-0.82, 0.2, 0.15] } },
      { at: FOUND.holdEnd, pose: { pos: [0.3, 0.3, 4.9], look: [-0.82, 0.2, 0.15] } },
    ],
    settle: { pos: [0.25, 0.26, 4.6], look: [-0.78, 0.18, 0.1] },
  },
  checked: {
    captionShare: 0.82,
    align: "end",
    // Held on the print, on the left of the words, while the hairline circles it.
    arrive: { pos: [0.25, 0.18, 4.2], look: [1, 0.06, 0] },
    settle: { pos: [0.18, 0.14, 4.4], look: [0.95, 0.05, 0] },
  },
  lookalike: {
    captionShare: 0.86,
    align: "start",
    // Pulled back to hold both prints on the right, the words on the left. A
    // phone holds them side by side across the shot, high enough that the rail
    // and its dates stay inside it above the words.
    arrive: { pos: [0, 0.3, 6.4], look: [-1.3, 0.05, 0] },
    settle: { pos: [0.1, 0.22, 5.9], look: [-1.25, 0, 0] },
    phone: {
      arrive: { pos: [0, 0.1, 5.5], look: [0, -0.85, 0] },
      settle: { pos: [0.05, 0.05, 5.2], look: [0, -0.85, 0] },
    },
  },
  yourself: {
    captionShare: 0.8,
    align: "start",
    // In on the print that came from beyond the wall's edge, the words on the left.
    arrive: { pos: [0.3, 0.2, 5.2], look: [-1, 0.05, 0] },
    settle: { pos: [0.25, 0.16, 4.8], look: [-0.95, 0.05, 0] },
  },
  waiting: {
    captionShare: 0.75,
    align: "start",
    // A slow drift over the wall while the words and the tray say it.
    arrive: { pos: [0.6, 0.5, 6.4], look: [-0.5, 0.1, -1] },
    settle: { pos: [0.5, 0.45, 6], look: [-0.45, 0.1, -1] },
  },
  offer: {
    captionShare: 0.79,
    align: "end",
    // The print takes the left half and the drop panel the right.
    arrive: { pos: [-1.6, 0.3, 4.5], look: [0.85, 0.06, 0] },
    settle: { pos: [-1.45, 0.24, 4.3], look: [0.78, 0.05, 0] },
  },
  close: {
    captionShare: 1,
    align: "start",
    // Out, and the field comes back up: the last screen is about how many there are.
    arrive: { pos: [0.1, 0.45, 6.6], look: [-0.95, -0.1, -0.6] },
    settle: { pos: [0.58, 0.92, 8.5], look: [-0.55, -0.25, -1.6] },
  },
};

/** One cut of the film: its pages, its beats, and the camera path they make. */
export interface BeatTable {
  /** The beats in this cut, in playing order. */
  names: BeatName[];
  /** Screens of page the film's section takes: the travel plus the one screen the stage stays pinned on. */
  pages: number;
  /** A caption's fade, in this cut's own fractions, so it is the same scroll distance in every cut. */
  fade: number;
  beats: Beat[];
  /** Every beat this cut carries, by name. A beat left out simply has no key. */
  beat: Partial<Record<BeatName, Beat>> & Record<AlwaysBeat, Beat>;
  /**
   * The camera path, straight out of the table: every beat contributes the pose
   * it has arrived at when its caption starts, any poses it holds on the way,
   * and the pose it has drifted to when the caption is gone. All the travelling
   * therefore happens between one caption leaving and the next arriving.
   */
  cameraKeys: BeatKey[];
}

const held = new Map<string, BeatTable>();

/**
 * The table for a cut, built once per set of beats so a screen holding one
 * holds the same object all the way through. The beats always play in the
 * script's order whatever order they are handed in, and the six that every cut
 * carries are put in if they were left out.
 */
export function beatTable(present: readonly BeatName[]): BeatTable {
  const names = BEAT_ORDER.filter(
    (name) => present.includes(name) || (ALWAYS as readonly BeatName[]).includes(name),
  ) as BeatName[];
  const key = names.join(",");
  const ready = held.get(key);
  if (ready !== undefined) {
    return ready;
  }

  const travel = names.reduce((sum, name) => sum + PACE[name], 0);
  let at = 0;
  const beats: Beat[] = names.map((name) => {
    const shape = SHAPES[name];
    const length = PACE[name] / travel;
    const start = at;
    const end = name === "close" ? 1 : at + length;
    at += length;
    return {
      name,
      start,
      end,
      captionStart: start,
      captionEnd: shape.captionShare >= 1 ? 1 : start + (end - start) * shape.captionShare,
      align: shape.align,
      arrive: shape.arrive,
      settle: shape.settle,
      between: (shape.between ?? []).map((key) => ({ ...key, at: start + (end - start) * key.at })),
      phone: shape.phone,
    };
  });

  const table: BeatTable = {
    names,
    pages: Math.round((travel + 1) * 100) / 100,
    fade: CAPTION_FADE_SCREENS / travel,
    beats,
    beat: Object.fromEntries(beats.map((entry) => [entry.name, entry])) as BeatTable["beat"],
    cameraKeys: beats.flatMap((entry) => [
      { at: entry.start, pose: entry.arrive, phone: entry.phone?.arrive },
      ...entry.between,
      { at: entry.captionEnd, pose: entry.settle, phone: entry.phone?.settle },
    ]),
  };
  held.set(key, table);
  return table;
}

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** 0 before `from`, 1 after `to`, straight line between. */
export function span(t: number, from: number, to: number): number {
  return to <= from ? (t >= to ? 1 : 0) : clamp01((t - from) / (to - from));
}

/** How far through one beat the scroll is, 0 to 1. */
export function within(t: number, beat: Pick<Beat, "start" | "end">): number {
  return span(t, beat.start, beat.end);
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

/** The beats whose words the field steps out from behind: those with body copy beside the scene. Not the opening's wall, not the offer's panel, not the close. */
const CLEARED: BeatName[] = ["imagined", "sealed", "stated", "asked", "shared", "verified", "checked", "lookalike", "yourself", "waiting"];

/**
 * Which side of the frame the words are on at this moment and how far up they
 * are, 0 to 1, so the field can clear the copy column (scene/field.tsx). A
 * phone stacks the words under the shot, so nothing is cleared there.
 */
export function wordsCover(table: BeatTable, t: number, phone: boolean): { side: "start" | "end" | null; cover: number } {
  if (phone) {
    return { side: null, cover: 0 };
  }
  let side: "start" | "end" | null = null;
  let cover = 0;
  for (const name of CLEARED) {
    const beat = table.beat[name];
    if (beat === undefined) {
      continue;
    }
    const shown = captionCue(t, beat, table.fade).shown;
    if (shown > cover) {
      side = beat.align;
      cover = shown;
    }
  }
  return { side, cover };
}

export const easeOut = (x: number, power = 3) => 1 - Math.pow(1 - clamp01(x), power);

export const smooth = (x: number) => {
  const c = clamp01(x);
  return c * c * (3 - 2 * c);
};
