// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type FunctionComponent, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";
import type { Consent } from "@/lib/chain/consent";
import { InlineLedger } from "@/components/story/StatedLedger";
import { plateEdge, progress, resetPlateEdge } from "@/components/story/signals";

/**
 * The drawing's own animation frame, and the plate it follows.
 *
 * Both are the film's cheapest kind of bug: nothing looks wrong, and a browser
 * is doing work for a reader who cannot see any of it. The inline drawing is
 * display:none from 640 px up, where the pinned one takes over, and its loop
 * ran there for the life of the page. The plate's edge is four plain numbers
 * the scene writes and nobody clears.
 */

const CLOSED: Consent = {
  aiTraining: "notAllowed",
  aiGenerativeTraining: "notAllowed",
  aiInference: "notAllowed",
  dataMining: "notAllowed",
};

const view = {
  consent: CLOSED,
  dated: true,
  notch: 0.4,
  registered: "17 Sep 2026",
  writtenShort: "18 Sep 2026",
};

/** A hand-wound animation frame, so a test can say exactly how many ran. */
const frames = (() => {
  let nextId = 1;
  const pending = new Map<number, FrameRequestCallback>();
  return {
    waiting: () => pending.size,
    request(callback: FrameRequestCallback) {
      const id = nextId;
      nextId += 1;
      pending.set(id, callback);
      return id;
    },
    cancel(id: number) {
      pending.delete(id);
    },
    turn(times = 1) {
      for (let at = 0; at < times; at += 1) {
        const due = [...pending.entries()];
        pending.clear();
        for (const [, callback] of due) {
          callback(0);
        }
      }
    },
    clear() {
      pending.clear();
      nextId = 1;
    },
  };
})();

/** The one observer the drawing makes, held so a test can say what it saw. */
const seen: { watching: Element | null; tell: ((on: boolean) => void) | null; live: boolean } = {
  watching: null,
  tell: null,
  live: false,
};

class Watcher {
  constructor(private readonly answer: (entries: { isIntersecting: boolean }[]) => void) {
    seen.tell = (on: boolean) => this.answer([{ isIntersecting: on }]);
  }

  observe(node: Element) {
    seen.watching = node;
    seen.live = true;
  }

  disconnect() {
    seen.live = false;
  }

  unobserve() {
    seen.live = false;
  }
}

function render(node: ReactElement): { host: HTMLElement; root: Root } {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(createElement(Provider, { locale: "en", messages: en, timeZone: "UTC" }, node));
  });
  return { host, root };
}

vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.request(callback));
vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.cancel(id));
vi.stubGlobal("IntersectionObserver", Watcher);
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  frames.clear();
  seen.watching = null;
  seen.tell = null;
  seen.live = false;
  progress.stated = 0;
});

describe("the drawing that stacks with the words", () => {
  it("asks for no frame at all until its element is really on screen", () => {
    const { host, root } = render(createElement(InlineLedger, { view, driven: true }));

    expect(seen.watching).toBe(host.querySelector('[data-stated-ledger="inline"]'));
    expect(frames.waiting()).toBe(0);

    act(() => root.unmount());
  });

  it("draws while the element is on screen", () => {
    const { host, root } = render(createElement(InlineLedger, { view, driven: true }));
    const rule = host.querySelector<HTMLElement>('[data-rule="drawn"]');

    expect(rule?.style.transform).toBe("scaleX(0)");
    progress.stated = 1;
    act(() => seen.tell?.(true));
    frames.turn(2);

    expect(frames.waiting()).toBe(1);
    expect(rule?.style.transform).toBe("scaleX(1.0000)");

    act(() => root.unmount());
  });

  it("stops the moment the element is gone, which on a desktop is from the first frame", () => {
    const { root } = render(createElement(InlineLedger, { view, driven: true }));

    act(() => seen.tell?.(true));
    frames.turn(1);
    expect(frames.waiting()).toBe(1);

    act(() => seen.tell?.(false));
    expect(frames.waiting()).toBe(0);

    // A second answer of the same kind cannot leave a second loop behind.
    act(() => seen.tell?.(true));
    act(() => seen.tell?.(true));
    expect(frames.waiting()).toBe(1);

    act(() => root.unmount());
  });

  it("leaves no loop and no observer behind when the beat goes", () => {
    const { root } = render(createElement(InlineLedger, { view, driven: true }));
    act(() => seen.tell?.(true));
    frames.turn(1);

    act(() => root.unmount());

    expect(frames.waiting()).toBe(0);
    expect(seen.live).toBe(false);
  });

  it("draws itself finished and asks for nothing when it is not driven", () => {
    const { host, root } = render(createElement(InlineLedger, { view }));

    expect(host.querySelector<HTMLElement>('[data-rule="drawn"]')?.style.transform).toBe("scaleX(1)");
    expect(seen.watching).toBeNull();
    expect(frames.waiting()).toBe(0);

    act(() => root.unmount());
  });
});

/**
 * Where the plate was, after the plate has gone.
 *
 * The rule is drawn in the document and follows numbers the scene publishes, so
 * a scene that has gone leaves it with the last place it saw. Reset the way the
 * film's own `ended` and `past` are reset when their loop stops.
 */
describe("the plate's edge", () => {
  it("is forgotten, not left standing at the last place a plate was", () => {
    plateEdge.shown = true;
    plateEdge.leftX = -0.4;
    plateEdge.leftY = -0.2;
    plateEdge.rightX = 0.4;
    plateEdge.rightY = -0.18;

    resetPlateEdge();

    expect(plateEdge).toEqual({ shown: false, leftX: 0, leftY: 0, rightX: 0, rightY: 0 });
  });

  it("is put back by the plate itself, on a cut change and on the way out", () => {
    const source = readFileSync("components/story/scene/field.tsx", "utf8");
    expect(source).toContain("resetPlateEdge");
    // The effect runs on a cut change and hands back the same reset as its cleanup.
    expect(source).toContain("return resetPlateEdge;");
  });
});
