// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type FunctionComponent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { guideKeys } from "@/components/guide/steps";

/**
 * The card lands where it belongs, and is never seen anywhere else first.
 *
 * The audit's desktop filmstrip caught it at the top left corner of the screen
 * for a frame, then sliding across to its anchor. That is a motion element
 * with no starting point of its own, which framer starts at nought. This
 * watches every change the walk makes to the card, from the moment it is
 * mounted, and records what a reader could have seen at each one.
 */

vi.mock("@/lib/i18n/routing", () => ({
  Link: ({ href, className, children }: { href: string; className?: string; children?: ReactNode }) =>
    createElement("a", { href, className }, children),
}));

const { GuideWalk } = await import("@/components/guide/GuideWalk");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CARD_HEIGHT = 244;

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
  // jsdom lays nothing out, so every box is zero. The card is the one thing
  // the walk measures by its height, and a real phone measured it at 244.
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute("data-guide-card") ? CARD_HEIGHT : 0;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

function messages(): Record<string, unknown> {
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

function boxAt(node: Element, rect: { left: number; top: number; width: number; height: number }) {
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

interface Seen {
  state: string | null;
  hidden: boolean;
  transform: string;
}

/** The two numbers a translate carries, whichever way framer chose to write it. */
function moved(transform: string): [number, number] {
  const numbers = [...transform.matchAll(/-?[\d.]+(?=px)/g)].map((match) => Number(match[0]));
  return [numbers[0] ?? 0, numbers[1] ?? 0];
}

describe("the card on open", () => {
  it("is never seen before it has its place, and is first seen exactly there", async () => {
    // A phone's frame, 375 by 812, with the Verify tab on the bar at the foot.
    const scope = document.createElement("div");
    scope.innerHTML = '<a data-guide-anchor="verify">Verify</a>';
    document.body.append(scope);
    boxAt(scope, { left: 0, top: 0, width: 375, height: 812 });
    boxAt(scope.firstElementChild as Element, { left: 150, top: 756, width: 75, height: 56 });

    const seen: Seen[] = [];
    const record = () => {
      const card = document.querySelector<HTMLElement>("[data-guide-card]");
      if (card !== null) {
        seen.push({
          state: card.getAttribute("data-guide-card"),
          hidden: card.style.visibility === "hidden",
          transform: card.style.transform,
        });
      }
    };
    const watcher = new MutationObserver(record);
    watcher.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["style", "data-guide-card"] });

    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        createElement(
          Provider,
          { locale: "en", messages: messages(), timeZone: "Asia/Kolkata" },
          createElement(GuideWalk, { open: true, onClose: () => undefined, stage: "frame", scope: { current: scope } }),
        ),
      );
    });
    for (let tries = 0; tries < 20; tries += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
    }
    watcher.disconnect();
    record();
    act(() => root.unmount());

    // The light on the tab: 150 - 8, 756 - 8, padded 8 all round. The card is
    // 244 high, with no room under the tab, so it sits 16 above the light and
    // at the left gutter, because below a laptop the card is the screen less
    // its two 16 px gutters: 343 wide on a 375 screen.
    const final = seen[seen.length - 1];
    expect(final.state).toBe("placed");
    expect(final.hidden).toBe(false);
    expect(moved(final.transform)).toEqual([16, 748 - 16 - CARD_HEIGHT]);

    // It was measured before it was placed, unseen.
    expect(seen.some((one) => one.state === "measuring")).toBe(true);
    for (const one of seen.filter((entry) => entry.state === "measuring")) {
      expect(one.hidden).toBe(true);
    }

    // Every frame a reader could have seen has the card where it ends up: it
    // never shows at the corner and never slides in from it.
    for (const one of seen.filter((entry) => !entry.hidden)) {
      expect(moved(one.transform)).toEqual([16, 748 - 16 - CARD_HEIGHT]);
    }
  });
});
