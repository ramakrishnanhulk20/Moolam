// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { reachableIn, lockPage, tabTarget } from "@/components/guide/focus";

/**
 * The guide is the one thing on this site allowed to interrupt somebody, so the
 * ways out of it are the part worth proving: Escape closes it, a keyboard
 * cannot wander out of it into the page it is covering, the page under it does
 * not scroll and does not move, and the walk goes one, two, three and stops.
 */

vi.mock("@/lib/i18n/routing", () => ({
  Link: ({ href, className, children }: { href: string; className?: string; children?: ReactNode }) =>
    createElement("a", { href, className }, children),
}));

const { GuideCards } = await import("@/components/guide/GuideCards");
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

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

async function mount(node: ReactNode): Promise<HTMLDivElement> {
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    createRoot(host).render(node);
  });
  return host;
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

describe("drawing A, the three cards", () => {
  it("shows the three, in order, each with a way there", async () => {
    const host = await mount(createElement(GuideCards, { open: true, onClose: () => undefined, stage: "frame" }));
    // The arrow beside a title on a phone is decorative and hidden from
    // anything that reads the page out, so it is dropped here too.
    const titles = [...host.querySelectorAll("h3")].map((node) => node.firstChild?.textContent);
    expect(titles).toEqual(["Check any picture", "Make one and get its passport", "Find yours"]);
    expect([...host.querySelectorAll("a")].map((node) => node.getAttribute("href"))).toEqual([
      "/verify",
      "/studio",
      "/mine",
    ]);
    expect(host.querySelector('[role="dialog"]')?.getAttribute("aria-modal")).toBe("true");
    expect(host.textContent).toContain("Shown once");
  });

  it("closes on Escape and on a press on the ground", async () => {
    const closed: string[] = [];
    const host = await mount(
      createElement(GuideCards, { open: true, onClose: (why: string) => closed.push(why), stage: "frame" }),
    );

    await act(async () => press(host, "Escape"));
    expect(closed).toEqual(["escape"]);

    const ground = host.querySelector("[data-guide-open] > div");
    await act(async () => {
      ground?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(closed).toEqual(["escape", "ground"]);

    await act(async () => buttonNamed(host, "Skip").click());
    expect(closed).toEqual(["escape", "ground", "skip"]);
  });

  it("paints nothing at all while it is shut", async () => {
    const host = await mount(createElement(GuideCards, { open: false, onClose: () => undefined, stage: "frame" }));
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe("drawing B, the walk", () => {
  it("goes one, two, three and then closes", async () => {
    const closed: string[] = [];
    const host = await mount(
      createElement(GuideWalk, { open: true, onClose: (why: string) => closed.push(why), stage: "frame" }),
    );

    expect(host.querySelector("h3")?.textContent).toBe("Check any picture");
    expect(host.textContent).toContain("01 of 03");

    await act(async () => buttonNamed(host, "Next").click());
    expect(host.querySelector("h3")?.textContent).toBe("Make one and get its passport");

    await act(async () => buttonNamed(host, "Next").click());
    expect(host.querySelector("h3")?.textContent).toBe("Find yours");
    expect(host.textContent).toContain("03 of 03");

    await act(async () => buttonNamed(host, "Done").click());
    expect(closed).toEqual(["done"]);
  });

  it("closes on Escape and on Skip", async () => {
    const closed: string[] = [];
    const host = await mount(
      createElement(GuideWalk, { open: true, onClose: (why: string) => closed.push(why), stage: "frame" }),
    );
    await act(async () => press(host, "Escape"));
    await act(async () => buttonNamed(host, "Skip").click());
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

  function box(node: Element, rect: { left: number; top: number; width: number; height: number }) {
    node.getBoundingClientRect = () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height, x: rect.left, y: rect.top, toJSON: () => "" }) as DOMRect;
  }

  it("sits on the real thing, measured against the stage and padded", () => {
    const root = page('<span data-guide-anchor="verify">Verify an image</span>');
    box(root.firstElementChild as Element, { left: 300, top: 70, width: 120, height: 20 });

    expect(spotFor("verify", root, origin)).toEqual({ x: 192, y: 12, width: 136, height: 36, standIn: false });
  });

  it("falls back to the menu and says so when the real thing is not on the page", () => {
    const root = page('<button data-guide-anchor="menu">Menu</button>');
    box(root.firstElementChild as Element, { left: 320, top: 60, width: 60, height: 36 });

    const spot = spotFor("mine", root, origin);
    expect(spot?.standIn).toBe(true);
    expect(spot?.width).toBe(76);
  });

  it("points at nothing rather than at the wrong thing", () => {
    expect(spotFor("mine", page("<p>a page with no header</p>"), origin)).toBeNull();
  });
});
