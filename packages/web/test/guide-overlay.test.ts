// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type FunctionComponent, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { reachableIn, lockPage, tabTarget } from "@/components/guide/focus";
import { guideKeys } from "@/components/guide/steps";

/**
 * The guide is the one thing on this site allowed to interrupt somebody, so the
 * ways out of it are the part worth proving: Escape closes it, a keyboard
 * cannot wander out of it into the page it is covering, the page under it does
 * not scroll and does not move, and the walk goes one, two, three and stops.
 */

vi.mock("@/lib/i18n/routing", () => ({
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

const { GuideWalk, spotFor } = await import("@/components/guide/GuideWalk");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

async function mount(node: ReactNode): Promise<HTMLDivElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(
      createElement(Provider, { locale: "en", messages: guideMessages(), timeZone: "Asia/Kolkata" }, node as never),
    );
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

function press(host: HTMLElement, key: string, shiftKey = false) {
  const panel = host.querySelector('[role="dialog"]');
  if (panel === null) {
    throw new Error("the guide is not open");
  }
  panel.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true }));
}

function buttonNamed(host: HTMLElement, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((node) => node.textContent?.trim().startsWith(label));
  if (found === undefined) {
    throw new Error(`no button reads ${label}`);
  }
  return found;
}

describe("keeping the keyboard inside the guide", () => {
  function panelOf(html: string): HTMLElement {
    const root = document.createElement("div");
    root.innerHTML = html;
    document.body.append(root);
    return root;
  }

  it("lists only what a Tab could land on", () => {
    const root = panelOf(
      '<a href="/verify">one</a><button>two</button><button disabled>no</button><span tabindex="-1">no</span><button hidden>no</button>',
    );
    expect(reachableIn(root).map((node) => node.textContent)).toEqual(["one", "two"]);
  });

  it("brings Tab off the last control back to the first", () => {
    const root = panelOf('<button>one</button><button>two</button>');
    const [first, last] = reachableIn(root);
    expect(tabTarget(root, last, false)).toBe(first);
    expect(tabTarget(root, first, true)).toBe(last);
    expect(tabTarget(root, first, false)).toBeNull();
  });

  it("pulls focus back in when it has landed on the page underneath", () => {
    const root = panelOf('<button>one</button><button>two</button>');
    const outside = document.createElement("button");
    document.body.append(outside);
    expect(tabTarget(root, outside, false)).toBe(reachableIn(root)[0]);
    expect(tabTarget(root, null, false)).toBe(reachableIn(root)[0]);
  });

  it("holds focus on the panel itself when there is nothing in it", () => {
    const root = panelOf("<p>nothing to press</p>");
    expect(tabTarget(root, null, false)).toBe(root);
  });
});

describe("the page under the guide", () => {
  it("does not scroll while it is open, and is handed back exactly as it was", () => {
    document.body.style.paddingRight = "4px";
    const release = lockPage();
    expect(document.body.style.overflow).toBe("hidden");
    release();
    expect(document.body.style.overflow).toBe("");
    expect(document.body.style.paddingRight).toBe("4px");
  });
});

describe("drawing B, the walk", () => {
  it("goes one, two, three and then closes", async () => {
    const closed: string[] = [];
    const host = await drawn(
      await mount(
        createElement(GuideWalk, { open: true, onClose: (why: string) => closed.push(why), stage: "frame" }),
      ),
    );

    expect(host.querySelector("h3")?.textContent).toBe("guide.steps.check.title");
    expect(host.textContent).toContain("01 of 03");

    await act(async () => buttonNamed(host, "guide.next").click());
    expect(host.querySelector("h3")?.textContent).toBe("guide.steps.make.title");

    await act(async () => buttonNamed(host, "guide.next").click());
    expect(host.querySelector("h3")?.textContent).toBe("guide.steps.find.title");
    expect(host.textContent).toContain("03 of 03");

    await act(async () => buttonNamed(host, "guide.done").click());
    expect(closed).toEqual(["done"]);
  });

  it("closes on Escape and on Skip", async () => {
    const closed: string[] = [];
    const host = await drawn(
      await mount(
        createElement(GuideWalk, { open: true, onClose: (why: string) => closed.push(why), stage: "frame" }),
      ),
    );
    await act(async () => press(host, "Escape"));
    await act(async () => buttonNamed(host, "guide.skip").click());
    expect(closed).toEqual(["escape", "skip"]);
  });
});

describe("where the light falls", () => {
  const origin = { left: 100, top: 50 } as DOMRect;

  function page(html: string): HTMLElement {
    const root = document.createElement("div");
    root.innerHTML = html;
    document.body.append(root);
    return root;
  }

  /**
   * Puts an element on the screen, in the one way the walk tests for.
   *
   * jsdom gives every element a zero box and no client rects, which is exactly
   * what a real browser reports for something display none. So an element left
   * alone here is an element that is not on this screen, and this is what it
   * takes to be on it.
   */
  function onScreen(node: Element, rect: { left: number; top: number; width: number; height: number }) {
    const box = {
      ...rect,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      x: rect.left,
      y: rect.top,
      toJSON: () => "",
    } as DOMRect;
    node.getBoundingClientRect = () => box;
    node.getClientRects = () => [box] as unknown as DOMRectList;
  }

  it("sits on the real thing, measured against the stage and padded", () => {
    const root = page('<span data-guide-anchor="verify">Verify an image</span>');
    onScreen(root.firstElementChild as Element, { left: 300, top: 70, width: 120, height: 20 });

    expect(spotFor("verify", root, origin)).toEqual({ x: 192, y: 12, width: 136, height: 36 });
  });

  it("takes the one that is on the screen, header or bar, without being told which", () => {
    // Both carry the anchor on every page. On a laptop the header's link is up
    // and the bar's tab is display none; on a phone it is the other way round.
    const root = page(
      '<a data-guide-anchor="verify">header</a><a data-guide-anchor="verify">bar tab</a>',
    );
    onScreen(root.children[1], { left: 40, top: 760, width: 75, height: 56 });

    expect(spotFor("verify", root, origin)).toEqual({ x: -68, y: 702, width: 91, height: 72 });
  });

  it("will not light something that has been switched off", () => {
    // The bar is inert while the film plays. A light on a tab nobody can press
    // would be pointing at a picture of a control.
    const root = page('<div inert><a data-guide-anchor="verify">bar tab</a></div>');
    onScreen(root.firstElementChild?.firstElementChild as Element, { left: 40, top: 760, width: 75, height: 56 });

    expect(spotFor("verify", root, origin)).toBeNull();
  });

  it("points at nothing rather than at the wrong thing", () => {
    expect(spotFor("mine", page("<p>a page with no header and no bar</p>"), origin)).toBeNull();
  });

  it("says where the thing is when none of it is on the screen, but not before it has waited", async () => {
    const host = await mount(
      createElement(GuideWalk, { open: true, onClose: () => undefined, stage: "frame" }),
    );
    // The bar arrives a moment after the page, so the walk waits half a second
    // before it will say a thing is missing. The wait is real time, not fake:
    // the loop that measures runs on animation frames.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
    });
    expect(host.textContent).toContain("guide.steps.check.elsewhere");
  });
});

describe("the words", () => {
  it("all come from the message files, none of them from the code", async () => {
    const host = await drawn(
      await mount(createElement(GuideWalk, { open: true, onClose: () => undefined, stage: "frame" })),
    );
    const said = host.textContent ?? "";

    for (const key of ["guide.skip", "guide.next", "guide.steps.check.title", "guide.steps.check.line"]) {
      expect(said).toContain(key);
    }
    expect(host.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("guide.dialog");
    // Two of the three steps are not on the screen yet, so their words must not
    // be either: one step at a time is the whole shape of this drawing.
    expect(said).not.toContain("guide.steps.make.title");
  });
});
