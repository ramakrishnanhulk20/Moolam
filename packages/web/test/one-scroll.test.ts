import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { easing } from "maath";
import { describe, expect, it } from "vitest";
import { DAMPING, damp, pageProgress } from "@/components/story/scroll";
import { FILM_STYLE } from "@/components/story/room";

/**
 * The film riding the page's own scroll (WO-297): one scrollbar, the stage
 * pinned inside a section as tall as the cut, the progress read from the
 * window and eased exactly as drei's scroller eased it. The home page keeps the
 * scroller until Ram approves the lab.
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
  it("is tried on the lab route alone, and the home page keeps the scroller", () => {
    expect(source("app/[locale]/lab/film/page.tsx")).toContain('scroll="page"');
    expect(source("app/[locale]/page.tsx")).not.toContain("scroll=");
    expect(source("components/story/StoryStage.tsx")).toContain("scroll={scroll}");
  });

  it("pins the stage inside a section as tall as the cut, dynamic on a phone", () => {
    const story = source("components/story/LandingStory.tsx");
    expect(story).toContain('data-film-scroll="page"');
    expect(story).toContain('"--film-screens": String(table.pages * travel)');
    expect(story).toContain("sticky top-0");
    expect(FILM_STYLE).toMatch(/\[data-film-scroll="page"\] \{\s*height: calc\(var\(--film-screens, 1\) \* 100svh\);/);
    expect(FILM_STYLE).toMatch(/\[data-film-scroll="page"\] \[data-film-stage\] \{\s*height: 100dvh;/);
  });

  it("hands nothing over on the page's scroll: no scroller, no keys, no hidden footer, only the dark bar's flag", () => {
    const story = source("components/story/LandingStory.tsx");
    const page = story.slice(story.indexOf("function PageFilm"), story.indexOf("const PHONE_TRAVEL"));
    expect(page).not.toContain("data-story-scroller");
    expect(page).not.toContain("keyReach");
    expect(page).toContain("damp(source, pageProgress(");
    const paged = story.slice(story.indexOf("if (paged) {"), story.indexOf("</section>"));
    expect(paged).not.toContain("data-lenis-prevent");
    expect(paged).not.toContain("forwardWheel");
    expect(paged).not.toContain("<FilmEnd");
    expect(paged).toContain("<FilmHere");
    expect(FILM_STYLE).toContain('body:has([data-film="film"]:not([data-film-scroll="page"])):not([data-story-end]) footer');
  });
});
