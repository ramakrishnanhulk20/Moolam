// @vitest-environment jsdom
import { act, createElement } from "react";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FilmGate } from "@/components/home/FilmGate";

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

async function mount() {
  host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    // The box draws the chapter's title while it waits, so it needs the words.
    root.render(
      createElement(
        NextIntlClientProvider,
        { locale: "en", messages: en, timeZone: "UTC" },
        createElement(FilmGate, null, createElement("div", { "data-the-film": true })),
      ),
    );
  });
}

const film = () => host.querySelector("[data-the-film]");

describe("the film's box", () => {
  it("holds its own full height open and does not mount the film on its own", async () => {
    await mount();

    expect(film()).toBeNull();
    expect(host.querySelector('[data-story="loading"]')?.className).toContain("h-[100svh]");
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
