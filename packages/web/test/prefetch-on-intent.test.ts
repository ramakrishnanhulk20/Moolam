// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Tab } from "@/components/shell/tabs";

/**
 * Verify and Explore are fetched when a reader reaches for them, not when the
 * link comes into view.
 *
 * Measured on 25 September: the Verify link in view pulled viem, the verify
 * client, the consent ABI and noble into the home page at 2.8 s on a phone, and
 * the live home page fetched Explore's payload and code by 2.4 s. Both sat
 * inside the window Lighthouse scores. Next 16 fetches a link with prefetch
 * false never, and a link with prefetch null (its default) as soon as it is in
 * view, so the whole switch is which of the two the Link is handed, and when.
 * The Link here is a stand-in that writes what it was handed on the anchor.
 */

vi.mock("@/lib/i18n/routing", () => ({
  Link: ({ href, prefetch, children, ...rest }: Record<string, unknown> & { href: string; children?: ReactNode }) =>
    createElement(
      "a",
      { href, "data-prefetch": prefetch === null ? "default" : String(prefetch), ...rest },
      children,
    ),
  usePathname: () => "/",
}));

const { BottomBar, IntentLink } = await import("@/components/shell/BottomBar");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
})) as unknown as typeof window.matchMedia;

/** The layout's own five, in the raised order. */
const TABS: Tab[] = [
  { key: "home", href: "/", label: "Home" },
  { key: "explore", href: "/explore", label: "Explore" },
  { key: "make", href: "/studio", label: "Make", prefetch: false, anchor: "studio" },
  { key: "verify", href: "/verify", label: "Verify", anchor: "verify" },
  { key: "mine", href: "/mine", label: "Mine", prefetch: false, anchor: "mine" },
];

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.replaceChildren();
});

async function mount(node: ReactNode): Promise<HTMLDivElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(node));
  return host;
}

function bar(): Promise<HTMLDivElement> {
  return mount(createElement(BottomBar, { tabs: TABS, label: "Places", shape: "raised", film: false }));
}

function tab(host: HTMLElement, key: string): HTMLAnchorElement {
  const found = host.querySelector<HTMLAnchorElement>(`[data-tab="${key}"]`);
  if (found === null) {
    throw new Error(`no ${key} tab`);
  }
  return found;
}

/** What each tab was told, keyed by tab. */
function flags(host: HTMLElement): Record<string, string | null> {
  return Object.fromEntries(TABS.map((one) => [one.key, tab(host, one.key).getAttribute("data-prefetch")]));
}

/** React builds pointerenter out of the pointerover the browser sends. */
async function pointAt(node: HTMLElement): Promise<void> {
  await act(async () => {
    node.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, relatedTarget: document.body }));
  });
}

async function touch(node: HTMLElement): Promise<void> {
  await act(async () => {
    node.dispatchEvent(new Event("touchstart", { bubbles: true }));
  });
}

async function focus(node: HTMLElement): Promise<void> {
  await act(async () => node.focus());
}

describe("the phone bar in view", () => {
  it("does not fetch Verify or Explore while the reader has only seen them", async () => {
    expect(flags(await bar())).toEqual({
      home: "undefined",
      explore: "false",
      make: "false",
      verify: "false",
      mine: "false",
    });
  });

  it("fetches Verify when a pointer reaches it, and nothing else with it", async () => {
    const host = await bar();
    await pointAt(tab(host, "verify"));
    expect(flags(host)).toMatchObject({ verify: "default", explore: "false", make: "false", mine: "false" });
  });

  it("fetches Verify when a thumb lands on it", async () => {
    const host = await bar();
    await touch(tab(host, "verify"));
    expect(tab(host, "verify").getAttribute("data-prefetch")).toBe("default");
  });

  it("fetches Explore when focus reaches it from the keyboard", async () => {
    const host = await bar();
    await focus(tab(host, "explore"));
    expect(tab(host, "explore").getAttribute("data-prefetch")).toBe("default");
    expect(tab(host, "verify").getAttribute("data-prefetch")).toBe("false");
  });

  it("never fetches the two wallet tabs, whatever the reader does", async () => {
    const host = await bar();
    for (const key of ["make", "mine"]) {
      await pointAt(tab(host, key));
      await touch(tab(host, key));
      await focus(tab(host, key));
      expect(tab(host, key).getAttribute("data-prefetch")).toBe("false");
    }
  });
});

describe("the header's links", () => {
  const layout = readFileSync("app/[locale]/layout.tsx", "utf8");

  it("marks Verify and Explore for intent and leaves Agents and Docs as they were", () => {
    const flag = (href: string) => {
      const line = layout.split("\n").find((one) => one.includes(`{ href: "${href}", label:`));
      return line?.match(/prefetch: ([^,]+),/)?.[1];
    };
    expect(flag("/verify")).toBe('"intent"');
    expect(flag("/explore")).toBe('"intent"');
    expect(flag("/agents")).toBe("undefined");
    expect(flag("/docs")).toBe("undefined");
    expect(flag("/studio")).toBe("false");
  });

  it("draws an intent link as IntentLink, which holds the fetch until a pointer, focus or touch", async () => {
    // The layout hands its table to HeaderNav, which draws the links.
    expect(layout).toContain("<HeaderNav links={nav}");
    const nav = readFileSync("components/shell/HeaderNav.tsx", "utf8");
    expect(nav).toContain('link.prefetch === "intent" ? (');
    expect(nav).toMatch(/<IntentLink\s+key=\{link\.href\}\s+\{\.\.\.props\}>/);
    expect(nav).toContain("href: link.href,");

    for (const reach of [pointAt, focus, touch]) {
      const host = await mount(createElement(IntentLink, { href: "/verify", className: "tap" }, "Verify"));
      const link = host.querySelector("a") as HTMLAnchorElement;
      expect(link.getAttribute("data-prefetch")).toBe("false");
      await reach(link);
      expect(link.getAttribute("data-prefetch")).toBe("default");
    }
  });

  it("still runs a handler the caller hands it", async () => {
    const entered = vi.fn();
    const host = await mount(createElement(IntentLink, { href: "/verify", onPointerEnter: entered }, "Verify"));
    await pointAt(host.querySelector("a") as HTMLAnchorElement);
    expect(entered).toHaveBeenCalledTimes(1);
  });
});
