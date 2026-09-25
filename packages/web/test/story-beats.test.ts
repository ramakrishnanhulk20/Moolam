import { describe, expect, it } from "vitest";
import { beatTable, type Beat } from "@/components/story/beats";

/**
 * The film's own table, pinned down.
 *
 * The pacing of the nine pages below was tuned beat by beat, so the numbers
 * are written out here in full rather than derived from the table they are
 * checking. Any cut of the film that changes one of them changes that pacing,
 * and this is the test that says so out loud.
 */

/** Screens of scroll the approved film runs on: nine pages, eight screens of travel. */
const APPROVED_PAGES = 9;

const APPROVED: Beat[] = [
  {
    name: "opening",
    start: 0,
    end: 0.112,
    captionStart: 0,
    captionEnd: 0.068,
    align: "start",
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
    arrive: { pos: [1.3, 0.72, 6.1], look: [0.95, 0.04, -0.1] },
    settle: { pos: [2.05, 1, 7.35], look: [1.15, 0.06, -0.35] },
  },
  {
    name: "verified",
    start: 0.536,
    end: 0.692,
    captionStart: 0.536,
    captionEnd: 0.668,
    align: "start",
    arrive: { pos: [-0.2, 0.85, 7], look: [-1.1, 0.7, 0.3] },
    settle: { pos: [0.3, 0.3, 4.5], look: [-0.62, 0.18, 0.15] },
  },
  {
    name: "trusted",
    start: 0.692,
    end: 0.824,
    captionStart: 0.692,
    captionEnd: 0.8,
    align: "end",
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
    arrive: { pos: [0.1, 0.45, 6.6], look: [-0.95, -0.1, -0.6] },
    settle: { pos: [0.58, 0.92, 8.5], look: [-0.55, -0.25, -1.6] },
  },
];

describe("the approved film", () => {
  const classic = beatTable("classic");

  it("runs on the nine pages and the eight beats as they were tuned, to the last offset", () => {
    expect(classic.pages).toBe(APPROVED_PAGES);
    expect(classic.beats).toEqual(APPROVED);
  });

  it("hands the camera two keys per beat, the arrival and the drift, in scroll order", () => {
    expect(classic.cameraKeys).toEqual(
      APPROVED.flatMap((beat) => [
        { at: beat.start, pose: beat.arrive },
        { at: beat.captionEnd, pose: beat.settle },
      ]),
    );
  });

  it("carries no stated beat at all, so the home page cannot reach one", () => {
    expect(classic.beat.stated).toBeUndefined();
    expect(classic.beats.map((beat) => beat.name)).not.toContain("stated");
  });

  it("leaves every beat some travel after its caption and no gap before the next one", () => {
    APPROVED.forEach((beat, at) => {
      expect(beat.captionEnd).toBeLessThanOrEqual(beat.end);
      if (at > 0) {
        expect(beat.start).toBeCloseTo(APPROVED[at - 1].end, 10);
      }
    });
  });
});

/**
 * The cut with the holder's word in it. The tuned pacing is measured in
 * screens of scroll, not in fractions, so that is what is checked here: every
 * old beat is the same length of thumb travel it is today, and the film is one
 * screen longer for the one new beat.
 */
describe("the stated cut", () => {
  const classic = beatTable("classic");
  const stated = beatTable("stated");

  /** A beat's length in screens, which is what a reader's thumb actually feels. */
  const screens = (beat: Beat, pages: number) => (beat.end - beat.start) * (pages - 1);

  it("adds one screen and no more", () => {
    expect(stated.pages).toBe(classic.pages + 1);
  });

  it("puts the new beat between the seal and the copies leaving", () => {
    expect(stated.beats.map((beat) => beat.name)).toEqual([
      "opening",
      "made",
      "sealed",
      "stated",
      "shared",
      "verified",
      "trusted",
      "offer",
      "close",
    ]);
  });

  it("leaves every approved beat the length in screens it has today", () => {
    for (const beat of APPROVED) {
      const same = stated.beat[beat.name];
      expect(same, `the stated cut has no ${beat.name} beat`).toBeDefined();
      expect(screens(same as Beat, stated.pages)).toBeCloseTo(screens(beat, APPROVED_PAGES), 10);
    }
  });

  it("gives the new beat exactly one screen of its own", () => {
    expect(screens(stated.beat.stated as Beat, stated.pages)).toBeCloseTo(1, 10);
  });

  it("keeps the camera, the sides and the reading share of every approved beat", () => {
    for (const beat of APPROVED) {
      const same = stated.beat[beat.name] as Beat;
      expect(same.align).toBe(beat.align);
      expect(same.arrive).toEqual(beat.arrive);
      expect(same.settle).toEqual(beat.settle);
      // How much of its own beat the caption is on screen for, which is the
      // difference between a reading and a travelling shot.
      expect((same.captionEnd - same.start) / (same.end - same.start)).toBeCloseTo(
        (beat.captionEnd - beat.start) / (beat.end - beat.start),
        10,
      );
    }
  });

  it("runs from 0 to 1 with no gap and no overlap, and holds the last caption to the end", () => {
    stated.beats.forEach((beat, at) => {
      expect(beat.captionEnd).toBeLessThanOrEqual(beat.end);
      expect(beat.start).toBeCloseTo(at === 0 ? 0 : stated.beats[at - 1].end, 12);
    });
    expect(stated.beats.at(-1)?.end).toBe(1);
    expect(stated.beats.at(-1)?.captionEnd).toBe(1);
  });

  it("fades a caption over the same scroll distance in both cuts, so a beat reads at one speed", () => {
    expect(stated.fade * (stated.pages - 1)).toBeCloseTo(classic.fade * (classic.pages - 1), 12);
  });

  it("arrives at the new beat before a word of it is on screen, close on the lower edge of the plate", () => {
    const beat = stated.beat.stated as Beat;
    expect(beat.captionStart).toBe(beat.start);
    // The words take the right, so the shot leaves the left of the frame to the plate.
    expect(beat.align).toBe("end");
    expect(beat.arrive.look[1]).toBeLessThan(-0.3);
    expect(beat.arrive.pos[2]).toBeLessThan(3.5);
    // A shot that holds perfectly still reads as a photograph.
    expect(beat.settle).not.toEqual(beat.arrive);
  });
});
