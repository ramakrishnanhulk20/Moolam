import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BAR_HEIGHT, BAR_ROOM, activeTab, barShown, type Tab } from "@/components/shell/tabs";

/**
 * The bar under the thumb: which tab a route lights, and the order a Tab key
 * walks it in.
 *
 * Both are things a reader notices the moment they are wrong. A passport opened
 * from the sheet that lights nothing leaves someone standing on a bar with no
 * mark on it, and a keyboard order that does not match the row a thumb sees is
 * the kind of thing only a test catches.
 */

// The bar is the app's locale aware Link and the route it is standing on. Both
// come from next-intl's navigation, which needs a request to exist; the bar
// takes the route as a prop as well, and that is what these render.
vi.mock("@/lib/i18n/routing", () => ({
  Link: ({ href, children, ...rest }: Record<string, unknown> & { href: string; children?: unknown }) => {
    // prefetch is Next's own prop and means nothing to an anchor. It is read
    // off the tab list further down instead, where its value is the point.
    delete rest.prefetch;
    return createElement("a", { href, ...rest }, children as never);
  },
  usePathname: () => "/",
}));

const WORDS: Tab[] = [
  { key: "home", href: "/", label: "Home" },
  { key: "explore", href: "/explore", label: "Explore" },
  { key: "verify", href: "/verify", label: "Verify" },
  { key: "make", href: "/studio", label: "Make", prefetch: false },
  { key: "mine", href: "/mine", label: "Mine" },
];

/** Drawing B lifts Make into the middle, so the row reads home, explore, make, verify, mine. */
const RAISED: Tab[] = [WORDS[0], WORDS[1], WORDS[3], WORDS[2], WORDS[4]];

describe("which tab a route lights", () => {
  it("lights home on the film and nowhere else", () => {
    expect(activeTab("/")).toBe("home");
    expect(activeTab("/explore")).not.toBe("home");
  });

  it("keeps Explore lit on a passport, an agent and the agent list", () => {
    expect(activeTab("/explore")).toBe("explore");
    expect(activeTab("/passport/0xabc123")).toBe("explore");
    expect(activeTab("/agents")).toBe("explore");
    expect(activeTab("/agent/7")).toBe("explore");
  });

  it("puts settling a challenge under Verify, where the answer came from", () => {
    expect(activeTab("/verify")).toBe("verify");
    expect(activeTab("/resolve/0xfeed")).toBe("verify");
  });

  it("lights Make on the studio and Mine on the fifth tab's own page", () => {
    expect(activeTab("/studio")).toBe("make");
    expect(activeTab("/studio?mode=generate")).toBe("make");
    expect(activeTab("/mine")).toBe("mine");
  });

  it("lights nothing on the docs, which still keep the bar", () => {
    expect(activeTab("/docs")).toBeNull();
    expect(activeTab("/docs/proof")).toBeNull();
    expect(barShown("/docs/proof")).toBe(true);
  });

  it("reads a route with a trailing slash as the same route", () => {
    expect(activeTab("/explore/")).toBe("explore");
    expect(activeTab("/")).toBe("home");
  });

  it("does not light a tab for a route that merely starts with its letters", () => {
    expect(activeTab("/verifier")).toBeNull();
    expect(activeTab("/studios")).toBeNull();
  });

  it("draws no bar on a bench, which draws its own", () => {
    expect(barShown("/lab")).toBe(false);
    expect(barShown("/lab/phone")).toBe(false);
    expect(barShown("/")).toBe(true);
  });
});

describe("the room the bar asks a page to leave", () => {
  it("is the bar's own height plus whatever the phone keeps for its home indicator", () => {
    expect(BAR_HEIGHT).toBe(56);
    expect(BAR_ROOM).toContain("56px");
    expect(BAR_ROOM).toContain("env(safe-area-inset-bottom)");
  });
});

describe("the order the bar is drawn and walked in", () => {
  it("walks the five tabs in the order a thumb sees them", async () => {
    expect(tabsIn(await render("flat", WORDS, "/"))).toEqual(["home", "explore", "verify", "make", "mine"]);
  });

  it("walks drawing B in its own order, with the raised Make in the middle", async () => {
    expect(tabsIn(await render("raised", RAISED, "/"))).toEqual(["home", "explore", "make", "verify", "mine"]);
  });

  it("marks exactly one tab as the page a reader is on", async () => {
    const markup = await render("flat", WORDS, "/verify");
    expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
    expect(markup).toMatch(/data-tab="verify"[^>]*data-active="true"/);
  });

  it("marks none of them on a docs page", async () => {
    const markup = await render("flat", WORDS, "/docs/proof");
    expect(markup).not.toContain('aria-current="page"');
    expect(markup).not.toContain('data-active="true"');
  });

  it("says the words it was handed and carries none of its own", async () => {
    const markup = await render("flat", WORDS, "/");
    for (const tab of WORDS) {
      expect(markup).toContain(`>${tab.label}<`);
    }
  });

  it("sends Make to the studio, and does not fetch it until it is pressed", async () => {
    const markup = await render("flat", WORDS, "/");
    expect(markup).toMatch(/href="\/studio"[^>]*data-tab="make"/);

    // The studio carries the wallet. A bar on every page that prefetched it
    // would pull half a megabyte of it behind every reading of the site.
    const { TABS } = await import("@/components/lab/phone/words");
    expect(TABS.find((tab) => tab.key === "make")?.prefetch).toBe(false);
    expect(TABS.filter((tab) => tab.prefetch === false)).toHaveLength(1);
  });
});

describe("whether the bar is seen, and whether it can be reached", () => {
  it("is simply there on every page that is not the film", async () => {
    const { barLook } = await import("@/components/shell/BottomBar");
    expect(barLook({ guideOpen: false, filmPlaying: false, close: 0 })).toEqual({ opacity: 1, inert: false });
  });

  it("keeps out of the film until the closing card comes in", async () => {
    const { barLook } = await import("@/components/shell/BottomBar");
    expect(barLook({ guideOpen: false, filmPlaying: true, close: 0 })).toEqual({ opacity: 0, inert: true });
    expect(barLook({ guideOpen: false, filmPlaying: true, close: 0.25 })).toEqual({ opacity: 0.25, inert: true });
    expect(barLook({ guideOpen: false, filmPlaying: true, close: 1 })).toEqual({ opacity: 1, inert: false });
  });

  it("takes itself out of the tab order for exactly as long as it cannot be seen", async () => {
    const { barLook } = await import("@/components/shell/BottomBar");
    expect(barLook({ guideOpen: false, filmPlaying: true, close: 0.5 }).inert).toBe(true);
    expect(barLook({ guideOpen: false, filmPlaying: true, close: 0.51 }).inert).toBe(false);
  });

  it("is awake while the guide is open, whatever the film is doing", async () => {
    const { barLook } = await import("@/components/shell/BottomBar");
    // Two of the guide's three steps point at tabs. A bar that is invisible and
    // inert on the film's first screen would leave the walk pointing at nothing.
    expect(barLook({ guideOpen: true, filmPlaying: true, close: 0 })).toEqual({ opacity: 1, inert: false });
    expect(barLook({ guideOpen: true, filmPlaying: false, close: 0 })).toEqual({ opacity: 1, inert: false });
  });

  it("goes back to the film's own rule the moment the guide closes", async () => {
    const { barLook } = await import("@/components/shell/BottomBar");
    const open = barLook({ guideOpen: true, filmPlaying: true, close: 0.1 });
    const shut = barLook({ guideOpen: false, filmPlaying: true, close: 0.1 });
    expect(open).toEqual({ opacity: 1, inert: false });
    expect(shut).toEqual({ opacity: 0.1, inert: true });
  });

  it("never asks for an opacity outside nothing and all of it", async () => {
    const { barLook } = await import("@/components/shell/BottomBar");
    expect(barLook({ guideOpen: false, filmPlaying: true, close: -3 }).opacity).toBe(0);
    expect(barLook({ guideOpen: false, filmPlaying: true, close: 4 }).opacity).toBe(1);
  });

  it("reads the two facts off the page and nothing else", () => {
    const source = readFileSync("components/shell/BottomBar.tsx", "utf8");
    expect(source).toContain('document.querySelector("[data-guide-open]")');
    expect(source).toContain("document.querySelector('[data-story=\"film\"]')");
    expect(source).toContain("close: progress.close");
  });
});

async function render(shape: "flat" | "raised", tabs: Tab[], at: string): Promise<string> {
  const { BottomBar } = await import("@/components/shell/BottomBar");
  const bar = BottomBar as unknown as FunctionComponent<{
    tabs: Tab[];
    label: string;
    shape: "flat" | "raised";
    at: string;
    film: boolean;
  }>;
  return renderToStaticMarkup(
    createElement(bar, { tabs, label: "Sections", shape, at, film: false }) as ReactElement,
  );
}

/** Every tab in the markup, in the order the document holds them, which is the order Tab walks. */
function tabsIn(markup: string): string[] {
  return [...markup.matchAll(/data-tab="([a-z]+)"/g)].map((found) => found[1]);
}
