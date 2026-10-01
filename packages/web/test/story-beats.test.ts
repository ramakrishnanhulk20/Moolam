import { describe, expect, it } from "vitest";
import { BEAT_ORDER, FOUND, beatTable, type Beat, type BeatName } from "@/components/story/beats";
import { PACE, readingSeconds, screensFor } from "@/components/story/pace";

/**
 * The film's own table, pinned down.
 *
 * Ram approved the pace on the story lab on 1 October: every beat of the
 * story-v2 script, twelve screens for the whole film, about two minutes. The
 * lengths are written out here in full rather than read from the table they
 * are checking, so a cut that changes one says so out loud.
 */

const APPROVED_SCREENS: Record<BeatName, number> = {
  opening: 0.6,
  imagined: 0.9,
  sealed: 0.85,
  stated: 0.95,
  asked: 0.8,
  shared: 0.85,
  verified: 1.35,
  checked: 0.95,
  lookalike: 1.05,
  yourself: 0.95,
  waiting: 0.8,
  offer: 1,
  close: 0.95,
};

/** The camera paths of the beats that stay from the film before, to the last number. */
const KEPT_PATHS: Partial<Record<BeatName, Pick<Beat, "align" | "arrive" | "settle">>> = {
  opening: {
    align: "start",
    arrive: { pos: [0.9, 0.35, 7.4], look: [-0.85, 0, 0] },
    settle: { pos: [0.74, 0.3, 6.55], look: [-0.8, 0, 0] },
  },
  imagined: {
    align: "start",
    arrive: { pos: [0.36, 0.1, 4.05], look: [-0.75, 0, 0] },
    settle: { pos: [0.3, 0.06, 3.78], look: [-0.72, 0, 0] },
  },
  stated: {
    align: "end",
    arrive: { pos: [-0.44, -0.26, 2.86], look: [0.64, -0.52, 0] },
    settle: { pos: [-0.3, -0.32, 2.66], look: [0.56, -0.46, 0] },
  },
  shared: {
    align: "end",
    arrive: { pos: [1.3, 0.72, 6.1], look: [0.95, 0.04, -0.1] },
    settle: { pos: [2.05, 1, 7.35], look: [1.15, 0.06, -0.35] },
  },
  offer: {
    align: "end",
    arrive: { pos: [-1.6, 0.3, 4.5], look: [0.85, 0.06, 0] },
    settle: { pos: [-1.45, 0.24, 4.3], look: [0.78, 0.05, 0] },
  },
  close: {
    align: "start",
    arrive: { pos: [0.1, 0.45, 6.6], look: [-0.95, -0.1, -0.6] },
    settle: { pos: [0.58, 0.92, 8.5], look: [-0.55, -0.25, -1.6] },
  },
};

/** A beat's length in screens, which is what a reader's thumb actually feels. */
const screens = (beat: Beat, pages: number) => (beat.end - beat.start) * (pages - 1);

describe("the whole film", () => {
  const whole = beatTable([...BEAT_ORDER]);

  it("plays every beat of the script, in the script's order", () => {
    expect(whole.names).toEqual([...BEAT_ORDER]);
  });

  it("runs in twelve screens, about two minutes", () => {
    expect(PACE).toEqual(APPROVED_SCREENS);
    expect(screensFor(whole.names)).toBe(12);
    expect(whole.pages).toBe(13);
    expect(readingSeconds(whole.names)).toBe(120);
  });

  it("gives every beat its approved length in screens", () => {
    for (const beat of whole.beats) {
      expect(screens(beat, whole.pages), beat.name).toBeCloseTo(APPROVED_SCREENS[beat.name], 10);
    }
  });

  it("gives the signature beat the most scroll, and holds the camera still at its snap", () => {
    const longest = Math.max(...Object.values(APPROVED_SCREENS));
    expect(APPROVED_SCREENS.verified).toBe(longest);
    const found = whole.beat.verified;
    const length = found.end - found.start;
    const snap = found.between.find((key) => key.at === found.start + length * FOUND.snap);
    const hold = found.between.find((key) => key.at === found.start + length * FOUND.holdEnd);
    expect(snap).toBeDefined();
    expect(snap?.pose).toEqual(hold?.pose);
  });

  it("keeps the camera paths and the sides of the beats that stay", () => {
    for (const [name, path] of Object.entries(KEPT_PATHS)) {
      const beat = whole.beat[name as BeatName] as Beat;
      expect(beat.align, name).toBe(path.align);
      expect(beat.arrive, name).toEqual(path.arrive);
      expect(beat.settle, name).toEqual(path.settle);
    }
  });

  it("runs from 0 to 1 with no gap and no overlap, leaves every caption before its beat ends, and holds the last", () => {
    whole.beats.forEach((beat, at) => {
      expect(beat.captionStart).toBe(beat.start);
      expect(beat.captionEnd).toBeLessThanOrEqual(beat.end);
      expect(beat.start).toBeCloseTo(at === 0 ? 0 : whole.beats[at - 1].end, 12);
    });
    expect(whole.beats.at(-1)?.end).toBe(1);
    expect(whole.beats.at(-1)?.captionEnd).toBe(1);
  });

  it("hands the camera its keys in scroll order", () => {
    const at = whole.cameraKeys.map((key) => key.at);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(whole.cameraKeys[0].pose).toEqual(whole.beat.opening.arrive);
  });
});

describe("a shorter cut", () => {
  const whole = beatTable([...BEAT_ORDER]);
  const today = beatTable(["opening", "imagined", "sealed", "shared", "verified", "checked", "offer", "close"]);

  it("takes a left-out beat's scroll with it rather than leaving a gap", () => {
    expect(today.pages).toBeCloseTo(1 + 0.6 + 0.9 + 0.85 + 0.85 + 1.35 + 0.95 + 1 + 0.95, 10);
    for (const beat of today.beats) {
      expect(screens(beat, today.pages), beat.name).toBeCloseTo(APPROVED_SCREENS[beat.name], 10);
    }
  });

  it("always carries the six beats every cut needs, and plays in the script's order whatever it is handed", () => {
    expect(beatTable(["close", "opening"]).names).toEqual(["opening", "sealed", "shared", "verified", "offer", "close"]);
  });

  it("fades a caption over the same scroll distance in every cut, so a beat reads at one speed", () => {
    expect(today.fade * (today.pages - 1)).toBeCloseTo(whole.fade * (whole.pages - 1), 12);
  });

  it("is built once per set of beats, so a screen holds the same table all the way through", () => {
    expect(beatTable(today.names)).toBe(today);
  });
});
