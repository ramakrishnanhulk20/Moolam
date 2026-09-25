// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Fragment, act, createElement, type FunctionComponent, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { GUIDE_SEEN_KEY, RETURNING_KEY } from "@/components/guide/seen";
import { guideKeys } from "@/components/guide/steps";

/**
 * Who gets the first visit walk, who never does, and how somebody who skipped
 * it asks for it back.
 *
 * The guide is the one thing on this site allowed to interrupt a reader, so
 * every gate on it is worth a case: the mark on the device, the mark the wallet
 * leaves, and the server pass, which must render nothing at
 * all or React would throw away the tree it is hydrating.
 */

const here = { path: "/" };

// The real Link forwards onClick and then navigates, so the mock forwards it
// too: the mark is written by that handler, and a mock that swallowed it would
// have hidden the one case this file cares about most.
vi.mock("@/lib/i18n/routing", () => ({
  usePathname: () => here.path,
  useRouter: () => ({ push: () => undefined }),
  Link: ({
    href,
    className,
    onClick,
    children,
  }: {
    href: string;
    className?: string;
    onClick?: () => void;
    children?: ReactNode;
  }) => createElement("a", { href, className, onClick }, children),
}));

const { FirstVisitGuide } = await import("@/components/guide/FirstVisitGuide");
const { GUIDE_OPEN_EVENT } = await import("@/components/guide/signal");
const { ShowGuideAgain } = await import("@/components/guide/ShowGuideAgain");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Every guide key, with its own name as its value, so a word can be traced back to its key. */
function guideMessages(): Record<string, unknown> {
  const tree: Record<string, unknown> = {};
  for (const key of guideKeys()) {
    const parts = key.split(".");
    let node = tree;
    for (const part of parts.slice(0, -1)) {
      node[part] = node[part] ?? {};
      node = node[part] as Record<string, unknown>;
    }
    node[parts[parts.length - 1]] = key === "guide.step" ? "{shown} of {total}" : key;
  }
  return tree;
}

const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
  locale: string;
  messages: unknown;
  timeZone: string;
  children: ReactNode;
}>;

function wrap(node: ReactNode) {
  return createElement(
    Provider,
    { locale: "en", messages: guideMessages(), timeZone: "Asia/Kolkata" },
    node as never,
  );
}

async function mount(node: ReactNode): Promise<HTMLDivElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(wrap(node));
  });
  return host;
}

/**
 * Waits for the walk to draw its card.
 *
 * It looks for its anchor before it says anything, and in a test nothing is
 * ever on the screen, so the card arrives when that wait is over. A page has
 * the same pause, and it is why the guide never lands in the wrong place.
 */
async function drawn(host: HTMLElement): Promise<HTMLElement> {
  for (let tries = 0; tries < 40; tries += 1) {
    if (host.querySelector("h3") !== null) {
      return host;
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  }
  throw new Error("the walk never drew its card");
}

function walking(host: HTMLElement): boolean {
  return host.querySelector('[role="dialog"]') !== null;
}

/**
 * Whether the walk arrives, given time.
 *
 * It looks for the thing its first step talks about before it draws anything at
 * all, so "is it open" is a question with a short wait in it. A shut guide is
 * asked the same way, for as long as the waiting would have taken, or the test
 * would pass on the pause rather than on the rule.
 */
async function opened(host: HTMLElement, ms = 2000): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 50) {
    if (walking(host)) {
      return true;
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  }
  return walking(host);
}

/**
 * Waits for the guide to finish leaving.
 *
 * A close is not instant: the ground fades and the card goes with it, and the
 * page lock is only handed back once that is over, which is what keeps the
 * close free of layout shift. So a test that looked straight after the press
 * would always find the dialog still there.
 */
async function gone(host: HTMLElement): Promise<boolean> {
  for (let tries = 0; tries < 40; tries += 1) {
    if (!walking(host)) {
      return true;
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  }
  return false;
}

function buttonNamed(host: HTMLElement, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((node) => node.textContent?.trim().startsWith(label));
  if (found === undefined) {
    throw new Error(`no button reads ${label}`);
  }
  return found;
}

beforeEach(() => {
  // The walk waits for the home page's hero to have painted its words. These
  // cases are about who is let in, so every page here has already painted.
  const hero = document.createElement("div");
  hero.setAttribute("data-hero-shown", "true");
  document.body.append(hero);
  window.localStorage.clear();
  here.path = "/";
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

// The walk measures on every animation frame, so a root left mounted keeps
// rendering into the next test, after its stand-ins have been taken away.
const roots: Root[] = [];

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) {
      root.unmount();
    }
  });
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("who is shown the walk", () => {
  it("opens it for a device that has never been here", async () => {
    expect(await opened(await mount(createElement(FirstVisitGuide)))).toBe(true);
  });

  it("stays shut once the device carries the mark", async () => {
    window.localStorage.setItem(GUIDE_SEEN_KEY, "1");
    expect(await opened(await mount(createElement(FirstVisitGuide)), 900)).toBe(false);
  });

  it("stays shut for a device that has signed in here before", async () => {
    window.localStorage.setItem(RETURNING_KEY, "1");
    expect(await opened(await mount(createElement(FirstVisitGuide)), 900)).toBe(false);
  });

  it("renders nothing on the server, whatever this browser holds", () => {
    expect(renderToStaticMarkup(wrap(createElement(FirstVisitGuide)))).toBe("");
  });
});

describe("the ways out", () => {
  it("writes the mark on Skip and does not come back", async () => {
    const host = await drawn(await mount(createElement(FirstVisitGuide)));
    await act(async () => buttonNamed(host, "guide.skip").click());

    expect(window.localStorage.getItem(GUIDE_SEEN_KEY)).toBe("1");
    expect(await gone(host)).toBe(true);
    expect(await opened(await mount(createElement(FirstVisitGuide)), 900)).toBe(false);
  });

  it("writes the mark when the last step is finished", async () => {
    const host = await drawn(await mount(createElement(FirstVisitGuide)));
    for (let step = 0; step < 2; step += 1) {
      await act(async () => buttonNamed(host, "guide.next").click());
    }
    await act(async () => buttonNamed(host, "guide.done").click());
    expect(window.localStorage.getItem(GUIDE_SEEN_KEY)).toBe("1");
  });

  it("writes the mark when a step's own link is followed", async () => {
    const host = await drawn(await mount(createElement(FirstVisitGuide)));
    const link = host.querySelector('a[href="/verify"]');
    await act(async () => {
      link?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(window.localStorage.getItem(GUIDE_SEEN_KEY)).toBe("1");
    expect(await gone(host)).toBe(true);
  });
});

describe("asking for it back from the footer", () => {
  it("forgets the mark and opens the guide on the spot, with nothing shared between them", async () => {
    window.localStorage.setItem(GUIDE_SEEN_KEY, "1");
    const host = await mount(
      createElement(Fragment, null, createElement(FirstVisitGuide), createElement(ShowGuideAgain)),
    );
    expect(await opened(host, 900)).toBe(false);

    await act(async () => buttonNamed(host, "Show the guide again").click());

    expect(window.localStorage.getItem(GUIDE_SEEN_KEY)).toBeNull();
    expect(await opened(host)).toBe(true);
  });

  it("opens on the event alone, wherever it was sent from", async () => {
    window.localStorage.setItem(GUIDE_SEEN_KEY, "1");
    const host = await mount(createElement(FirstVisitGuide));
    await act(async () => {
      window.dispatchEvent(new Event(GUIDE_OPEN_EVENT));
    });
    expect(await opened(host)).toBe(true);
  });
});
