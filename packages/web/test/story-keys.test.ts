import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import {
  film,
  filmPlace,
  forwardTouchMove,
  forwardTouchStart,
  forwardWheel,
  keyReach,
  moveStory,
  scroller,
  type StoryView,
} from "@/components/story/signals";
import { beatTable } from "@/components/story/beats";

/**
 * The two ends of the home page, the ones a reader could not reach on
 * 2026-09-21: the footer under the film, and the film itself from a keyboard.
 *
 * The keys are answered by a pure function, so the whole map is testable here:
 * a key and where the story stands go in, and what the page and the story
 * should do comes out. What a browser then does with it is measured in
 * scripts/perf/story-reach.mjs.
 */

/** A film eight screens long in a 900 px window, at its opening frame. */
const opening = (over: Partial<StoryView> = {}): StoryView => ({
  top: 0,
  max: 8000,
  height: 900,
  pageTop: 0,
  above: 0,
  lead: 0,
  ...over,
});

const BEAT = 1000;

/** A film of nine pages, eight screens of travel. A key press is one of its screens. */
const PAGES = 9;

describe("the keys that drive the film", () => {
  it("moves one beat on Page Down, a beat being one of the eight screens of travel", () => {
    expect(keyReach("PageDown", false, opening(), PAGES)).toEqual({ story: { by: BEAT }, page: null });
  });

  it("puts that beat on the scroller the wheel moves, so the story keeps one place to read its progress from", () => {
    const el = { scrollTop: 0, scrollHeight: 9000, clientHeight: 1000 } as HTMLElement;
    const reach = keyReach("PageDown", false, opening(), PAGES);
    moveStory(el, reach!.story!);
    expect(el.scrollTop).toBe(BEAT);
  });

  it("reads Space as Page Down and Shift and Space as Page Up", () => {
    expect(keyReach(" ", false, opening({ top: BEAT }), PAGES)).toEqual({ story: { by: BEAT }, page: null });
    expect(keyReach(" ", true, opening({ top: BEAT }), PAGES)).toEqual({ story: { by: -BEAT }, page: null });
  });

  it("moves a sixth of a beat on an arrow", () => {
    expect(keyReach("ArrowDown", false, opening(), PAGES)).toEqual({ story: { by: BEAT / 6 }, page: null });
    expect(keyReach("ArrowUp", false, opening({ top: 4000 }), PAGES)).toEqual({ story: { by: -BEAT / 6 }, page: null });
  });

  it("takes both ends on End and Home, the page and the story together", () => {
    expect(keyReach("End", false, opening(), PAGES)).toEqual({ story: { to: "end" }, page: { to: "end" } });
    expect(keyReach("Home", false, opening({ top: 8000, pageTop: 300 }), PAGES)).toEqual({
      story: { to: "start" },
      page: { to: "start" },
    });
  });

  it("winds the scroller to its own end, which is the last beat", () => {
    const el = { scrollTop: 250, scrollHeight: 9000, clientHeight: 1000 } as HTMLElement;
    moveStory(el, { to: "end" });
    expect(el.scrollTop).toBe(8000);
    moveStory(el, { to: "start" });
    expect(el.scrollTop).toBe(0);
  });

  it("takes its step from the cut being played, not from a number of its own", () => {
    const whole = beatTable(["opening", "imagined", "sealed", "stated", "asked", "shared", "verified", "checked", "offer", "close"]);
    // The cut's own screens of travel over the same scroller, so one press is
    // one of them. A step that stayed an eighth would stop part way into every beat.
    expect(keyReach("PageDown", false, opening(), whole.pages)).toEqual({
      story: { by: 8000 / (whole.pages - 1) },
      page: null,
    });
    expect(keyReach("ArrowDown", false, opening(), whole.pages)).toEqual({
      story: { by: 8000 / (whole.pages - 1) / 6 },
      page: null,
    });
  });

  it("hands Tab and every other key back to the browser", () => {
    for (const key of ["Tab", "Enter", "Escape", "a", "F5"]) {
      expect(keyReach(key, false, opening(), PAGES)).toBeNull();
    }
  });

  it("moves the page under the film once the story has no more to give, which is how a keyboard reaches the footer", () => {
    expect(keyReach("PageDown", false, opening({ top: 8000 }), PAGES)).toEqual({ story: null, page: { by: 900 } });
    expect(keyReach("ArrowDown", false, opening({ top: 8000 }), PAGES)).toEqual({ story: null, page: { by: 150 } });
  });

  it("brings the page back before it rewinds a single frame of the story", () => {
    expect(keyReach("PageUp", false, opening({ top: 8000, pageTop: 300 }), PAGES)).toEqual({
      story: null,
      page: { by: -900 },
    });
  });

  it("rewinds the story once the page is back on the last beat", () => {
    expect(keyReach("PageUp", false, opening({ top: 8000 }), PAGES)).toEqual({ story: { by: -BEAT }, page: null });
  });
});

/**
 * The home page's first screen sits above the film, so the film no longer
 * starts at the top of the page. These are the keys and the place rule that
 * had to learn that: the page carries the reader down to the film and back up
 * off its first frame, and the story only moves while the film fills the window.
 */
describe("the film under the home page's first screen", () => {
  it("is coming while the page above it shows, here once it fills the window, gone once the page is below it", () => {
    expect(filmPlace(973, 0, 973)).toBe("coming");
    expect(filmPlace(223, 750, 973)).toBe("coming");
    expect(filmPlace(0, 973, 973)).toBe("here");
    expect(filmPlace(-400, 1373, 1800)).toBe("gone");
  });

  it("counts the film as here at the foot of the page, where a phone with its address bar folded away cannot lift it higher", () => {
    // The window is 56 px taller than the film once the bar folds, so the
    // film's top stops 56 px down with the page at its end.
    expect(filmPlace(56, 1892, 1892)).toBe("here");
  });

  it("moves the page toward the film and stops at its top edge, never the story", () => {
    expect(keyReach("PageDown", false, opening({ above: 400, lead: 973 }), PAGES)).toEqual({
      story: null,
      page: { by: 400 },
    });
    expect(keyReach("ArrowDown", false, opening({ above: 973, lead: 973 }), PAGES)).toEqual({
      story: null,
      page: { by: 150 },
    });
    expect(keyReach("PageUp", false, opening({ above: 400, lead: 973 }), PAGES)).toEqual({
      story: null,
      page: { by: -900 },
    });
  });

  it("goes on up the page from the film's first frame, and rewinds the story from anywhere after it", () => {
    expect(keyReach("PageUp", false, opening({ lead: 973 }), PAGES)).toEqual({ story: null, page: { by: -900 } });
    expect(keyReach("PageUp", false, opening({ top: 3000, lead: 973 }), PAGES)).toEqual({
      story: { by: -BEAT },
      page: null,
    });
  });

  it("still plays the story on the way down once the film is here", () => {
    expect(keyReach("PageDown", false, opening({ lead: 973 }), PAGES)).toEqual({ story: { by: BEAT }, page: null });
  });
});

/**
 * A drag or a wheel over what is left of the film, once the page has scrolled
 * below it. The story must not take any of it: the reader is on their way back
 * to the last beat, and a story that rewinds here takes the footer away with it.
 */
describe("a gesture over the film once the page has gone past it", () => {
  const outside = { name: "a node on a panel above the scroller" } as unknown as Node;
  let el: { scrollTop: number; contains: (node: Node) => boolean };

  beforeEach(() => {
    el = { scrollTop: 4000, contains: () => false };
    scroller.el = el as unknown as HTMLElement;
    film.past = false;
    film.ended = false;
  });

  it("leaves the story alone on the wheel", () => {
    film.past = true;
    forwardWheel({ deltaY: -120, target: outside });
    expect(el.scrollTop).toBe(4000);
  });

  it("still carries the wheel to the story while the page is on the film", () => {
    forwardWheel({ deltaY: -120, target: outside });
    expect(el.scrollTop).toBe(3880);
  });

  it("latches a drag that began past the film, so the rest of it cannot rewind the story", () => {
    film.past = true;
    forwardTouchStart({ target: outside, touches: { length: 1, 0: { clientY: 200 } } });
    // The page reaches its top part way through the same drag.
    film.past = false;
    forwardTouchMove({ target: outside, touches: { length: 1, 0: { clientY: 500 } } });
    expect(el.scrollTop).toBe(4000);
  });
});

/**
 * The two attributes the film writes on the body, and the rules in the film's
 * own stylesheet (room.ts) that hang on them. The rules are what let a gesture
 * out of the story and onto the page, so the names have to match on both sides.
 */
describe("the film's two attributes and the rules they switch", () => {
  const read = (relative: string) => readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), "utf8");
  const css = read("components/story/room.ts");
  const story = read("components/story/LandingStory.tsx");

  it("holds the scroll inside the story until the last beat has been read", () => {
    expect(css).toMatch(/\[data-story-scroller\] \{\s*overscroll-behavior-y: contain;/);
    expect(css).toContain("body:has([data-film=\"film\"]):not([data-story-end]) footer");
  });

  it("hands the scroll chain back at the moment the footer appears", () => {
    expect(css).toMatch(/body\[data-story-end\] \[data-story-scroller\],[^{]*\{\s*overscroll-behavior-y: auto;/);
  });

  it("gives a gesture over the film to the page once the page has gone past it", () => {
    expect(css).toMatch(/body\[data-story-past\] \[data-story-scroller\] \{\s*pointer-events: none;/);
  });

  it("draws the focus ring inside a scroller the size of the window", () => {
    expect(css).toMatch(/\[data-story-scroller\]:focus-visible \{\s*outline-offset: -3px;/);
  });

  it("is written from the film's own frame, both of them, and cleared when the film goes", () => {
    expect(story).toContain('flag("data-story-end", done)');
    expect(story).toContain('flag("data-story-past", away)');
    expect(story).toContain('document.body.removeAttribute("data-story-end")');
    expect(story).toContain('document.body.removeAttribute("data-story-past")');
  });

  it("keeps the bar on its own ground over the first screen, and floats it on the shot only while the dark film is here", () => {
    expect(story).toContain('flag("data-story-here", here)');
    expect(story).toContain('document.body.removeAttribute("data-story-here")');
    expect(css).toMatch(
      /html\.dark body\[data-story-here\]:has\(\[data-film="film"\]\) \.app-header \{\s*background: transparent;/,
    );
    // Light, and a page with no theme class at all, keep the bar's own ground.
    expect(css).not.toContain("html:not(.light)");
  });

  it("lets a gesture out of the story at its first frame and over a film only part way up the window", () => {
    expect(story).toContain('flag("data-story-start", first)');
    expect(story).toContain('document.body.removeAttribute("data-story-start")');
    expect(css).toMatch(
      /body\[data-story-start\] \[data-story-scroller\],\s*body\[data-story-past\] \[data-film="film"\] \{\s*overscroll-behavior-y: auto;/,
    );
  });

  it("names the scroller and lets a keyboard land on it", () => {
    expect(story).toContain('el.setAttribute("role", "region")');
    expect(story).toContain('el.setAttribute("aria-label", label)');
    expect(story).toContain('el.setAttribute("tabindex", "0")');
  });
});
