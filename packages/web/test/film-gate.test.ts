// @vitest-environment jsdom
import { act, createElement, type ReactElement } from "react";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FilmGate } from "@/components/home/FilmGate";
import type { StoryData } from "@/components/story/data";
import { beatTable } from "@/components/story/beats";
import { FILM_STYLE } from "@/components/story/room";
import { filmCut, filmPages } from "@/components/story/stated";

/**
 * The film's box under the home page's first screen: it holds the film back
 * until the reader moves toward it, or until any of it is really on screen.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Seen = (entries: { intersectionRatio: number }[]) => void;
let observed: Seen[] = [];

beforeEach(() => {
  observed = [];
  class Watch {
    constructor(callback: Seen) {
      observed.push(callback);
    }
    observe() {}
    disconnect() {}
  }
  Object.defineProperty(window, "IntersectionObserver", { configurable: true, writable: true, value: Watch });
  globalThis.IntersectionObserver = window.IntersectionObserver;
});

let root: Root | null = null;
let host: HTMLElement;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

/** The data of a day with nothing but the beats every cut carries. */
const DAY: StoryData = {
  source: "chain",
  plates: [],
  focal: null,
  attestation: null,
  agent: null,
  statement: null,
  statementError: null,
  passportCount: null,
  attestationCount: null,
  error: null,
};

async function mount(child: ReactElement = createElement("div", { "data-the-film": true })) {
  host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    // The box draws the chapter's title while it waits, so it needs the words.
    root.render(
      createElement(
        NextIntlClientProvider,
        { locale: "en", messages: en, timeZone: "UTC" },
        createElement(FilmGate, null, child),
      ),
    );
  });
}

const film = () => host.querySelector("[data-the-film]");

describe("the film's box", () => {
  it("holds its own full height open and does not mount the film on its own", async () => {
    await mount();

    expect(film()).toBeNull();
    // The height itself is the rule in room.ts, from the pages on the box: the one pinned stage inside is the film's own.
    expect(host.querySelector('[data-film="loading"] [data-film-stage]')?.className).toContain("sticky");
    expect(host.querySelector<HTMLElement>("[data-film-gate]")?.style.getPropertyValue("--film-pages")).toBe("1");
  });

  it("holds open the screens the day's cut will take, read off the data its child was handed", async () => {
    await mount(createElement("div", { "data-the-film": true, data: DAY }));

    const held = host.querySelector<HTMLElement>("[data-film-gate]")?.style.getPropertyValue("--film-pages");
    expect(Number(held)).toBe(filmPages(DAY));
    expect(Number(held)).toBeGreaterThan(5);
    expect(held).toBe(String(beatTable(filmCut(DAY)).pages));
  });

  it("gives the box no more than one screen when no script will ever fill it", () => {
    expect(FILM_STYLE).toMatch(
      /@media \(scripting: none\) \{\s*\[data-film="loading"\] \{\s*--film-pages: 1;\s*--film-travel: 1;/,
    );
  });

  for (const move of ["wheel", "touchmove", "scroll", "keydown"]) {
    it(`mounts the film on the first ${move}`, async () => {
      await mount();
      await act(async () => {
        window.dispatchEvent(new Event(move));
      });

      expect(film()).not.toBeNull();
      expect(host.querySelector("[data-film-gate]")).toBeNull();
    });
  }

  it("mounts the film when a share of the box is really on screen, and not when it only touches the window's foot", async () => {
    await mount();
    await act(async () => {
      observed.forEach((callback) => callback([{ intersectionRatio: 0 }]));
    });
    expect(film()).toBeNull();

    await act(async () => {
      observed.forEach((callback) => callback([{ intersectionRatio: 0.2 }]));
    });
    expect(film()).not.toBeNull();
  });
});
