// @vitest-environment jsdom
import { NextIntlClientProvider } from "next-intl";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DiagramFrame } from "@/components/docs/DiagramFrame";
import { navPages } from "@/lib/docs/nav";
import { readPage } from "@/lib/docs/pages";

function fencesIn(body: string): string[] {
  return [...body.matchAll(/```mermaid\r?\n([\s\S]*?)```/g)].map((hit) => hit[1]);
}

const drawings = navPages().flatMap((page) => {
  const body = readPage(page.slug)?.body ?? "";
  return fencesIn(body).map((source, index) => ({ where: `${page.slug} #${index + 1}`, source }));
});

describe("the architecture diagrams", () => {
  it("are the three the page promises", () => {
    expect(drawings.map((drawing) => drawing.where)).toEqual([
      "developers/architecture #1",
      "developers/architecture #2",
      "developers/architecture #3",
    ]);
  });

  it("are all valid mermaid, so the browser can draw every one of them", async () => {
    const mermaid = (await import("mermaid")).default;
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "base" });
    for (const drawing of drawings) {
      await expect(mermaid.parse(drawing.source), drawing.where).resolves.toBeTruthy();
    }
  });
});

const svg = '<svg width="1400" height="300" viewBox="0 0 1400 300"><text x="10" y="20">Registry</text></svg>';
let host: HTMLDivElement | null = null;

async function mount() {
  host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      createElement(
        NextIntlClientProvider,
        { locale: "en", messages: { docs: { close: "Close" } } },
        createElement(DiagramFrame, { svg }),
      ),
    );
  });
  return host;
}

afterEach(() => {
  host?.remove();
  host = null;
});

describe("the frame around a diagram", () => {
  beforeAll(() => {
    // jsdom ships neither of these, and the frame measures itself with both.
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    globalThis.matchMedia ??= (query: string) =>
      ({
        matches: false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        onchange: null,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList;
  });

  it("offers the way into the full size view", async () => {
    const frame = await mount();
    const control = frame.querySelector("button.docs-diagram-open");
    expect(control?.textContent).toBe("Open full size");
  });

  it("puts the drawing in a region a keyboard can scroll, at its own size", async () => {
    const frame = await mount();
    const region = frame.querySelector<HTMLElement>(".docs-diagram-scroll");
    expect(region?.getAttribute("role")).toBe("region");
    expect(region?.tabIndex).toBe(0);
    // Lenis would otherwise swallow a sideways turn of the wheel.
    expect(region?.hasAttribute("data-lenis-prevent")).toBe(true);
    const drawn = region?.querySelector("svg");
    expect(drawn?.getAttribute("width")).toBe("1400");
  });
});
