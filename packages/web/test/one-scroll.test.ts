import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { easing } from "maath";
import { describe, expect, it } from "vitest";
import { DAMPING, damp, pageProgress } from "@/components/story/scroll";
import { FILM_STYLE } from "@/components/story/room";
import * as signals from "@/components/story/signals";

/**
 * The film rides the page's own scroll (WO-297, rolled in by WO-299): one
 * scrollbar, the stage pinned inside a section as tall as the cut, the progress
 * read from the window and eased exactly as drei's scroller eased it. The
 * scroller and every rule built to hand the wheel over are gone.
 */

const source = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");

describe("the page's scroll through the film's section", () => {
  it("is 0 while the section is on its way up, 1 once the stage unpins, and linear between", () => {
    // A cut of 11.8 screens in a 900 px window: a section 10 620 px tall with a 900 px stage.
    expect(pageProgress(400, 10620, 900)).toBe(0);
    expect(pageProgress(0, 10620, 900)).toBe(0);
    expect(pageProgress(-4860, 10620, 900)).toBeCloseTo(0.5, 9);
    expect(pageProgress(-9720, 10620, 900)).toBe(1);
    expect(pageProgress(-12000, 10620, 900)).toBe(1);
  });

  it("lands every beat where the scroller landed it: the travel is the section less one screen, as the scroller's was", () => {
    // The scroller's own length was (pages * travel - 1) screens; the section is pages * travel screens with one pinned.
    const pages = 11.8;
    const screen = 900;
    const section = pages * screen;
    for (const t of [0.06, 0.4, 0.75, 0.9438]) {
      const scrollerTop = t * (pages - 1) * screen;
      expect(pageProgress(-scrollerTop, section, screen)).toBeCloseTo(t, 9);
    }
  });

  it("eases with drei's own damping, number for number", () => {
    const mine = { offset: 0, velocity: 0 };
    const theirs = { offset: 0 };
    const targets = [0.02, 0.05, 0.05, 0.12, 0.3, 0.3, 0.3, 0.28, 0.5, 0.5, 0.9, 1, 1, 1];
    for (const target of targets) {
      damp(mine, target, DAMPING, 1 / 60);
      easing.damp(theirs, "offset", target, DAMPING, 1 / 60, Infinity, undefined, 0.00001);
      expect(mine.offset).toBeCloseTo(theirs.offset, 12);
    }
    expect(DAMPING).toBe(0.22);
  });

  it("settles on the target rather than crossing it", () => {
    const state = { offset: 0, velocity: 0 };
    for (let frame = 0; frame < 600; frame += 1) {
      damp(state, 0.4, DAMPING, 1 / 60);
      expect(state.offset).toBeLessThanOrEqual(0.4);
    }
    expect(state.offset).toBe(0.4);
  });
});

describe("the wiring", () => {
  const story = source("components/story/LandingStory.tsx");

  it("has nothing left to switch: the home page and the stage take no scroll or room to try", () => {
    expect(source("components/story/StoryStage.tsx")).not.toMatch(/scroll=|light=|scroll\?:|light\?:/);
    expect(source("app/[locale]/page.tsx")).not.toMatch(/scroll=|light=/);
    expect(story).not.toMatch(/scroll\?:|light\?:/);
    expect(() => source("app/[locale]/lab/film/page.tsx")).toThrow();
  });

  it("pins the stage inside a section as tall as the cut, dynamic on a phone", () => {
    expect(story).toContain('data-film="film"');
    expect(story).toContain('"--film-pages": String(table.pages)');
    expect(story).toContain("sticky top-0");
    expect(story).toContain("damp(source, pageProgress(");
    // The box that holds the film's place is under the same two rules, so the page below it does not move when the film arrives.
    expect(FILM_STYLE).toMatch(
      /\[data-film="film"\],\s*\[data-film="loading"\] \{\s*height: calc\(var\(--film-pages, 1\) \* var\(--film-travel, 1\) \* 100svh\);/,
    );
    expect(FILM_STYLE).toMatch(
      /:is\(\[data-film="film"\], \[data-film="loading"\]\) \[data-film-stage\] \{\s*height: 100dvh;/,
    );
  });

  it("hands nothing over: no scroller, no keys, no wheel forwarding, no hidden footer, no body flags but the bar's", () => {
    for (const gone of [
      "ScrollControls",
      "useScroll",
      "data-story-scroller",
      "keyReach",
      "moveStory",
      "movePage",
      "forwardWheel",
      "forwardTouch",
      "data-lenis-prevent",
      "FilmEnd",
      "data-film-scroll",
      "data-story-end",
      "data-story-past",
      "data-story-start",
    ]) {
      expect(story, gone).not.toContain(gone);
      expect(FILM_STYLE, gone).not.toContain(gone);
    }
    expect(story).toContain("<FilmHere");
    expect(FILM_STYLE).not.toMatch(/overscroll-behavior/);
    expect(FILM_STYLE).not.toMatch(/footer\s*\{/);
  });

  it("leaves the signals module with progress and the plate and probe readouts, and no hand-over helpers", () => {
    for (const name of ["scroller", "film", "keyReach", "moveStory", "movePage", "whenRoom", "forwardWheel", "forwardTouchStart", "forwardTouchMove"]) {
      expect(signals, name).not.toHaveProperty(name);
    }
    for (const name of ["progress", "plateEdge", "probe", "filmPlace", "filmArrived"]) {
      expect(signals, name).toHaveProperty(name);
    }
  });

  it("keeps Skip, which leaves the reader on the footer's first link", () => {
    expect(story).toContain('data-story-skip="true"');
    expect(story).toContain('document.querySelector<HTMLElement>("footer a")?.focus({ preventScroll: true });');
    expect(story).toContain("window.scrollTo({ top: document.documentElement.scrollHeight - window.innerHeight");
  });
});
