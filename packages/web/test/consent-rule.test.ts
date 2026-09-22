// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type FunctionComponent, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";
import { ConsentLedger } from "@/components/consent/ConsentLedger";
import { DAY_SECONDS, askedMinute, daysAcross, secondsForDay } from "@/components/consent/ledger";

/**
 * The rule on a passport page: what it asks the chain about, and what it tells
 * a reader they can do with it.
 *
 * Three things the weekly review found. Every reader asked about the second
 * their own card was opened, so no two readers shared an answer in front of the
 * route. A device running a day fast pushed the end of the rule past the window
 * the route will answer for at all. And a mouse in a narrow window was told to
 * drag, with the half of the sentence about the arrow keys kept for wide ones.
 */

const RENDERED = 1_789_990_000;
const REGISTERED = RENDERED - 10 * DAY_SECONDS;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function card(): ReactElement {
  return createElement(ConsentLedger, {
    id: `0x${"cd".repeat(32)}`,
    registeredAt: REGISTERED,
    now: RENDERED,
    entries: [],
    standing: { stated: false, entry: null },
  });
}

function mount(node: ReactElement): { host: HTMLElement; root: Root } {
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

/** The scrubber itself, whose last notch is the end of the rule. */
function thumb(host: HTMLElement): HTMLInputElement {
  const node = host.querySelector("input[type=range]");
  if (node === null) {
    throw new Error("the rule has no thumb");
  }
  return node as HTMLInputElement;
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    onchange: null,
    dispatchEvent: () => false,
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("the moment the card asks about", () => {
  it("is taken down to the whole minute, so every reader of a day asks the same URL", () => {
    expect(askedMinute(1_789_990_047)).toBe(1_789_990_020);
    expect(askedMinute(1_789_990_020)).toBe(1_789_990_020);
    expect(askedMinute(1_789_990_079)).toBe(1_789_990_020);
  });

  it("collapses the readers of one passport onto one question", () => {
    // Three readers opening the same card in the same minute. The end of the
    // rule is each one's own clock, so unaligned they asked three URLs for one
    // answer, and nothing in front of the route could share it.
    const clocks = [RENDERED + 3, RENDERED + 11, RENDERED + 19];
    const ends = clocks.map((clock) => secondsForDay(daysAcross(REGISTERED, clock), REGISTERED, clock));

    expect(new Set(ends).size).toBe(3);
    expect(new Set(ends.map(askedMinute)).size).toBe(1);
  });

  it("changes no answer, because the route rounds the same way before it reads the chain", () => {
    // roundedDown() in app/api/consent-at/route.ts. The chain was always asked
    // about the minute; only the URL was a reader's own.
    for (const day of [1, 7, 10]) {
      const at = secondsForDay(day, REGISTERED, RENDERED);
      expect(askedMinute(at)).toBe(at - (at % 60));
      expect(at - askedMinute(at)).toBeLessThan(60);
    }
  });

  it("asks about the registration minute itself at the near end of the rule", () => {
    const at = secondsForDay(0, REGISTERED, RENDERED);
    // Up to a minute before the picture was registered, where the register's
    // answer is the same as it is at the second it was: nothing stated.
    expect(at - askedMinute(at)).toBeLessThan(60);
  });
});

describe("a device whose clock is not the chain's", () => {
  // First on purpose. The reading of the browser's clock is held still between
  // renders and only ever moves forward inside one page, which is what keeps
  // React out of a loop, so a test that runs the clock back has to run before
  // any test that runs it on.
  it("is never let to pull the end of the rule backwards", () => {
    vi.setSystemTime((RENDERED - 3 * DAY_SECONDS) * 1_000);
    const { host, root } = mount(card());

    expect(thumb(host).max).toBe("10");

    act(() => root.unmount());
  });

  it("carries the rule forward to the reader's own today", () => {
    vi.setSystemTime((RENDERED + 2 * DAY_SECONDS) * 1_000);
    const { host, root } = mount(card());

    // Ten days of life and the cap's twenty three hours: eleven notches, not
    // the twelve a clock two days fast would have drawn.
    expect(thumb(host).max).toBe("11");

    act(() => root.unmount());
  });

  it("never asks about a moment the route would refuse", () => {
    vi.setSystemTime((RENDERED + 5 * DAY_SECONDS) * 1_000);
    const { host, root } = mount(card());

    const end = secondsForDay(Number(thumb(host).max), REGISTERED, RENDERED + 23 * 60 * 60);
    // The route answers for a day either side of its own now. The card's own
    // end is inside that window whatever the device thinks the time is.
    expect(end).toBeLessThanOrEqual(RENDERED + DAY_SECONDS);

    act(() => root.unmount());
  });
});

describe("what the rule tells a reader they can do", () => {
  it("says drag to everyone and names the arrow keys to a mouse at any width", () => {
    const { host, root } = mount(card());
    const hint = [...host.querySelectorAll("span")].filter((node) =>
      node.className.includes("pointer-fine"),
    );

    expect(hint).toHaveLength(2);
    const [touch, fine] = hint;
    expect(touch.className).toBe("pointer-fine:hidden");
    expect(touch.textContent).toBe(en.passport.consent.scrubTouch);
    expect(fine.className).toBe("hidden pointer-fine:inline");
    expect(fine.textContent).toBe(`${en.passport.consent.scrub}${en.passport.consent.scrubStep}`);

    // The width has nothing to do with whether a reader has arrow keys.
    for (const node of hint) {
      expect(node.className).not.toContain("sm:");
    }

    act(() => root.unmount());
  });
});
