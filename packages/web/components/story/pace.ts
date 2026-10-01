/**
 * How long each stop of the film takes to scroll, as Ram approved it on the
 * story lab (1 October): twelve screens for the whole script, about two
 * minutes.
 *
 * A screen is one window of wheel on a laptop and PHONE_TRAVEL of a window of
 * thumb on a phone. Each length includes the travel out to the next stop. At
 * reading pace one screen is about ten seconds (the old film read nine screens
 * in 70 to 90 seconds). The signature beat is the longest because the scroll
 * holds at its snap. A beat the day's data leaves out takes its screens with it,
 * so the film is shorter, never padded.
 */

import type { BeatName } from "@/components/story/beats";

export const PACE: Readonly<Record<BeatName, number>> = {
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

/** Seconds of reading per screen of scroll, measured off the old film. */
export const SECONDS_PER_SCREEN = 10;

/** The screens a cut covers, start to end, rounded to a hundredth. */
export function screensFor(beats: readonly BeatName[]): number {
  return Math.round(beats.reduce((sum, beat) => sum + PACE[beat], 0) * 100) / 100;
}

/** About how long a cut reads, in seconds. */
export function readingSeconds(beats: readonly BeatName[]): number {
  return Math.round(screensFor(beats) * SECONDS_PER_SCREEN);
}
