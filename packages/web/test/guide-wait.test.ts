// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type FunctionComponent, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";
import { GUIDE_SEEN_KEY, RETURNING_KEY } from "@/components/guide/seen";

/**
 * The walk waits for the hero it introduces.
 *
 * On slow 4G the audit watched it open 3.7 seconds before the hero, over a
 * black page: the walk only waited for React, and the hero is drawn by the
 * film's own scripts, which take far longer to arrive. The hero's credit block
 * now raises a mark once its words are on the screen, and the walk opens only
 * after that, still once per device and never for one that has signed in.
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

function askForLessMotion() {
  reduce.on = true;
  for (const listener of heard) {
    listener();
  }
}

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

/** What the hero's credit block raises once its words are on the screen. */
function paintHero() {
  const hero = document.createElement("div");
  hero.setAttribute("data-hero-shown", "true");
  document.body.append(hero);
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

describe("the hero's own mark", () => {
  function shown(): boolean {
    return document.querySelector("[data-hero-shown]") !== null;
  }

  function endRise() {
    const row = document.querySelector("[data-hero-call]")?.parentElement;
    if (row === null || row === undefined) {
      throw new Error("no row of calls");
    }
    // React listens for whichever name this browser gives the event.
    for (const name of ["animationend", "webkitAnimationEnd"]) {
      row.dispatchEvent(new Event(name, { bubbles: true }));
    }
  }

  it("is not up before the credits have entered", async () => {
    await mount(createElement(HeroCredits, { entered: false }));
    await wait(50);
    endRise();
    await wait(50);
    expect(shown()).toBe(false);
  });

  it("goes up once the two calls have finished rising, not when they start", async () => {
    await mount(createElement(HeroCredits, { entered: true }));
    await wait(50);
    expect(shown()).toBe(false);

    await act(async () => endRise());
    expect(shown()).toBe(true);
  });

  it("goes up at once for a reader who asked for less motion, since nothing rises", async () => {
    askForLessMotion();
    await mount(createElement(HeroCredits, { entered: true }));
    await wait(50);
    expect(shown()).toBe(true);
  });
});
