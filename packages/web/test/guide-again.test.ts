// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Fragment, act, createElement, type FunctionComponent, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { GUIDE_SEEN_KEY, RETURNING_KEY } from "@/components/guide/seen";
import { guideKeys } from "@/components/guide/steps";

/**
 * Show the guide again, pressed from a page that does not carry the walk.
 *
 * The footer is on every page and the walk is only on the home page, so a
 * press anywhere else has to take the reader to the walk rather than shout
 * into a page where nothing is listening. These cases hold the note that
 * crosses the navigation to one use, and hold the press to doing something a
 * reader can see even when the browser keeps nothing.
 */

const here = { path: "/" };
const push = vi.fn<(href: string) => void>();

vi.mock("@/lib/i18n/routing", () => ({
  usePathname: () => here.path,
  useRouter: () => ({ push }),
  Link: ({ href, className, children }: { href: string; className?: string; children?: ReactNode }) =>
    createElement("a", { href, className }, children),
}));

const { FirstVisitGuide } = await import("@/components/guide/FirstVisitGuide");
const { GUIDE_ASKED_KEY } = await import("@/components/guide/signal");
const { ShowGuideAgain } = await import("@/components/guide/ShowGuideAgain");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

async function mount(node: ReactNode): Promise<HTMLDivElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(
      createElement(
        Provider,
        { locale: "en", messages: guideMessages(), timeZone: "Asia/Kolkata" },
        node as never,
      ),
    );
  });
  return host;
}

/**
 * Whether the walk arrives, given time. It waits for its anchor before it
 * draws, so a shut guide is watched for as long as an open one would take.
 */
async function opened(host: HTMLElement, ms = 2000): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 50) {
    if (host.querySelector('[role="dialog"]') !== null) {
      return true;
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  }
  return host.querySelector('[role="dialog"]') !== null;
}

async function press(host: HTMLElement): Promise<void> {
  const button = [...host.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === "Show the guide again",
  );
  if (button === undefined) {
    throw new Error("the footer entry is missing");
  }
  await act(async () => button.click());
}

const realSessionStorage = Object.getOwnPropertyDescriptor(window, "sessionStorage");

/** A browser that refuses session storage outright, the way a locked down private window does. */
function refuseSessionStorage(): void {
  Object.defineProperty(window, "sessionStorage", {
    configurable: true,
    get() {
      throw new DOMException("storage is blocked", "SecurityError");
    },
  });
}

beforeEach(() => {
  // The walk waits for the home page's hero to have painted its words. These
  // cases are about who is let in, so every page here has already painted.
  const hero = document.createElement("div");
  hero.setAttribute("data-hero-shown", "true");
  document.body.append(hero);
  window.localStorage.clear();
  window.sessionStorage.clear();
  here.path = "/";
  push.mockClear();
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
  if (realSessionStorage !== undefined) {
    Object.defineProperty(window, "sessionStorage", realSessionStorage);
  }
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("a press on the home page", () => {
  it("opens the walk in place and goes nowhere", async () => {
    window.localStorage.setItem(GUIDE_SEEN_KEY, "1");
    const host = await mount(
      createElement(Fragment, null, createElement(FirstVisitGuide), createElement(ShowGuideAgain)),
    );
    expect(await opened(host, 900)).toBe(false);

    await press(host);

    expect(await opened(host)).toBe(true);
    expect(push).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(GUIDE_ASKED_KEY)).toBeNull();
  });
});

describe("a press anywhere else", () => {
  it("leaves the note, forgets the mark and takes the reader home", async () => {
    window.localStorage.setItem(GUIDE_SEEN_KEY, "1");
    here.path = "/explore";
    const host = await mount(createElement(ShowGuideAgain));

    await press(host);

    expect(window.sessionStorage.getItem(GUIDE_ASKED_KEY)).toBe("1");
    expect(window.localStorage.getItem(GUIDE_SEEN_KEY)).toBeNull();
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith("/");
  });

  it("opens the walk on arrival for a signed in device, spends the note, and a reload stays shut", async () => {
    window.localStorage.setItem(GUIDE_SEEN_KEY, "1");
    window.localStorage.setItem(RETURNING_KEY, "1");
    window.sessionStorage.setItem(GUIDE_ASKED_KEY, "1");

    const arrival = await mount(createElement(FirstVisitGuide));
    expect(await opened(arrival)).toBe(true);
    expect(window.sessionStorage.getItem(GUIDE_ASKED_KEY)).toBeNull();

    const reload = await mount(createElement(FirstVisitGuide));
    expect(await opened(reload, 900)).toBe(false);
  });

  // A signed in device, so the arrival stays shut unless a note got through,
  // and none can on a browser that refuses to keep one.
  it("still takes the reader home when the browser refuses storage, and nothing throws", async () => {
    window.localStorage.setItem(GUIDE_SEEN_KEY, "1");
    window.localStorage.setItem(RETURNING_KEY, "1");
    here.path = "/explore";
    refuseSessionStorage();
    const host = await mount(createElement(ShowGuideAgain));

    await press(host);
    expect(push).toHaveBeenCalledWith("/");

    here.path = "/";
    const arrival = await mount(createElement(FirstVisitGuide));
    expect(await opened(arrival, 900)).toBe(false);
  });
});
