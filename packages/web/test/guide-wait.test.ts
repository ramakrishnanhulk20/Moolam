// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type FunctionComponent, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";
import { GUIDE_SEEN_KEY, RETURNING_KEY } from "@/components/guide/seen";

/**
 * The walk waits for the first screen it introduces, and for nothing else.
 *
 * On slow 4G the audit watched it open 3.7 seconds before the hero, over a
 * black page, so the walk learned to wait for a mark. The mark used to be the
 * film's, and the film is now below the first screen and only mounted on the
 * first scroll, so a first visitor got no walk until they scrolled and then got
 * it over the first screen a second later. The first screen carries the mark
 * now, in its server markup, and the walk waits only for the rises under it to
 * settle. Still once per device and never for one that has signed in.
 */

const reduce = { on: false };

vi.mock("@/lib/i18n/routing", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: () => undefined }),
  Link: ({ href, prefetch, children, ...rest }: { href: string | { pathname: string }; prefetch?: boolean; children?: ReactNode }) =>
    createElement("a", { href: typeof href === "string" ? href : href.pathname, "data-prefetch": String(prefetch), ...rest }, children),
}));

const { FirstVisitGuide } = await import("@/components/guide/FirstVisitGuide");
const { HeroCredits } = await import("@/components/story/HeroCredits");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
  locale: string;
  messages: unknown;
  timeZone: string;
  children: ReactNode;
}>;

const roots: Root[] = [];

// framer asks once per page whether the reader wants less motion and then
// listens for a change, as a browser would announce one. These are its ears.
const heard = new Set<() => void>();

beforeEach(() => {
  window.localStorage.clear();
  reduce.on = false;
  for (const listener of heard) {
    listener();
  }
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return query.includes("reduce") ? reduce.on : false;
    },
    media: query,
    addEventListener: (_: string, listener: () => void) => heard.add(listener),
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    onchange: null,
    dispatchEvent: () => false,
  }));
});

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) {
      root.unmount();
    }
  });
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

async function mount(node: ReactNode): Promise<HTMLDivElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(createElement(Provider, { locale: "en", messages: en, timeZone: "Asia/Kolkata" }, node as never));
  });
  return host;
}

async function wait(ms: number) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

function walking(): boolean {
  return document.querySelector('[role="dialog"]') !== null;
}

/** Whether the walk is open within the time it takes to measure and draw, which is under a second. */
async function opensWithin(ms: number): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 50) {
    if (walking()) {
      return true;
    }
    await wait(50);
  }
  return walking();
}

/** The first screen's column, as the server draws it: the mark, the headline, the two calls, and no film anywhere. */
function paintHero(): HTMLElement {
  const hero = document.createElement("div");
  hero.setAttribute("data-hero-shown", "true");
  hero.innerHTML = '<h1 data-hero-words>Headline</h1><button data-hero-call="choose">Choose</button><a data-hero-call="make">Make one</a>';
  document.body.append(hero);
  return hero;
}

/** An animation as the browser lists it: running or finished, once or for ever. */
function animation(playState: AnimationPlayState, endTime: number): Animation {
  return { playState, effect: { getComputedTiming: () => ({ endTime }) } } as unknown as Animation;
}

describe("when the walk opens on a first visit", () => {
  it("waits, for as long as it takes, while the hero has not painted", async () => {
    await mount(createElement(FirstVisitGuide));
    // Longer than the walk ever needs to measure and draw once it is let go.
    expect(await opensWithin(2500)).toBe(false);
    expect(document.querySelector("[data-guide-open]")).toBeNull();
  });

  it("opens once the hero has painted, and not before", async () => {
    await mount(createElement(FirstVisitGuide));
    await wait(600);
    expect(walking()).toBe(false);

    paintHero();
    expect(await opensWithin(2000)).toBe(true);
  });

  it("still never opens for a device that has signed in, hero or not", async () => {
    window.localStorage.setItem(RETURNING_KEY, "1");
    paintHero();
    await mount(createElement(FirstVisitGuide));
    expect(await opensWithin(1500)).toBe(false);
  });

  it("still opens only once per device", async () => {
    window.localStorage.setItem(GUIDE_SEEN_KEY, "1");
    paintHero();
    await mount(createElement(FirstVisitGuide));
    expect(await opensWithin(1500)).toBe(false);
  });
});

describe("the first screen's own mark", () => {
  it("opens the walk on the first screen's paint with no film on the page at all", async () => {
    paintHero();
    await mount(createElement(FirstVisitGuide));
    expect(document.querySelector("[data-story]")).toBeNull();
    expect(await opensWithin(2000)).toBe(true);
  });

  it("waits while a rise under the mark is still running, and opens once it has finished", async () => {
    const hero = paintHero();
    let running = true;
    hero.getAnimations = () => [animation(running ? "running" : "finished", 890), animation("running", Infinity)];
    await mount(createElement(FirstVisitGuide));
    expect(await opensWithin(800)).toBe(false);

    running = false;
    expect(await opensWithin(2000)).toBe(true);
  });

  it("never waits on a pulse that runs for ever", async () => {
    const { heroSettled } = await import("@/components/guide/FirstVisitGuide");
    const node = document.createElement("div");
    node.getAnimations = () => [animation("running", Infinity), animation("finished", 650)];
    expect(heroSettled(node)).toBe(true);
    node.getAnimations = () => [animation("running", 650)];
    expect(heroSettled(node)).toBe(false);
  });

  it("is no longer raised by the film's credits, entered or not", async () => {
    await mount(createElement(HeroCredits, { entered: true }));
    const row = document.querySelector("a")?.parentElement;
    expect(row).not.toBeUndefined();
    await act(async () => {
      row?.dispatchEvent(new Event("animationend", { bubbles: true }));
    });
    expect(document.querySelector("[data-hero-shown]")).toBeNull();
  });
});
