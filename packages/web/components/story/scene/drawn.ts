/**
 * When the field's pictures actually reach the screen.
 *
 * "The page took fifteen seconds to show anything" was a stopwatch against a
 * browser pane, and a timer started in the app would only ever measure itself.
 * The renderer is the one thing that knows: a plate reports from its own
 * onAfterRender, the first frame it was drawn with a picture on it and enough
 * opacity to see. The two answers leave as performance marks, so
 * scripts/perf/first-plate.mjs reads them from outside the page and nothing in
 * the app reads them at all.
 *
 * Both marks are one shot. The adaptive tier rebuilds the whole field when it
 * steps, and a second field arriving later is not a second first picture.
 */

export const FIRST_PLATE = "moolam:first-plate";
export const HALF_PLATES = "moolam:half-plates";

const seen = new Set<string>();
let expected = 0;
let firstMarked = false;
let halfMarked = false;

/** How many plates the field is asking for, so half of them is a number. */
export function expectPlates(count: number): void {
  expected = Math.max(expected, count);
}

/** One plate, drawn with its picture on it for the first time. */
export function plateDrawn(key: string): void {
  if (typeof performance === "undefined" || seen.has(key)) {
    return;
  }
  seen.add(key);

  if (!firstMarked) {
    firstMarked = true;
    performance.mark(FIRST_PLATE);
  }
  if (!halfMarked && expected > 0 && seen.size >= Math.ceil(expected / 2)) {
    halfMarked = true;
    performance.mark(HALF_PLATES);
  }
}
