// @vitest-environment jsdom
import { NextIntlClientProvider } from "next-intl";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DiagramFrame } from "@/components/docs/DiagramFrame";
import { navPages } from "@/lib/docs/nav";
import { readPage } from "@/lib/docs/pages";

type Fence = { meta: string; source: string };

function fencesIn(body: string): Fence[] {
  return [...body.matchAll(/```mermaid([^\n]*)\r?\n([\s\S]*?)```/g)].map((hit) => ({
    meta: hit[1].trim(),
    source: hit[2],
  }));
}

/** Every id that carries a label, which is every box the reader sees. */
function nodesIn(source: string): string[] {
  return [...new Set([...source.matchAll(/(?:^|\s)([A-Za-z][\w-]*)\[/g)].map((hit) => hit[1]))];
}

/** Every label, broken at the line breaks it is written with. */
function labelLinesIn(source: string): string[] {
  return [...source.matchAll(/\[([^\]]*)\]/g)].flatMap((hit) => hit[1].split(/<br\s*\/?>/));
}

const drawings = navPages().flatMap((page) => {
  const body = readPage(page.slug)?.body ?? "";
  return fencesIn(body).map((fence, index) => ({
    where: `${page.slug} #${index + 1}`,
    phone: fence.meta.split(/\s+/)[0] === "phone",
    caption: /"([^"]*)"/.exec(fence.meta)?.[1] ?? null,
    source: fence.source,
  }));
});

const phones = drawings.filter((drawing) => drawing.phone);

describe("the architecture diagrams", () => {
  it("are the three of the page, each followed by the two redraws a phone gets", () => {
    expect(drawings.map((drawing) => `${drawing.where}${drawing.phone ? " phone" : ""}`)).toEqual([
      "developers/architecture #1",
      "developers/architecture #2 phone",
      "developers/architecture #3 phone",
      "developers/architecture #4",
      "developers/architecture #5 phone",
      "developers/architecture #6 phone",
      "developers/architecture #7",
      "developers/architecture #8 phone",
      "developers/architecture #9 phone",
    ]);
  });

  it("gives every redraw a line of its own, so a reader knows which half it is", () => {
    expect(phones).toHaveLength(6);
    for (const drawing of phones) {
      expect(drawing.caption, drawing.where).toMatch(/^Half (one|two): .+\.$/);
    }
  });

  it("draws every redraw top down, short enough to read on a phone", () => {
    for (const drawing of phones) {
      expect(drawing.source.trimStart().startsWith("flowchart TD"), drawing.where).toBe(true);
      expect(nodesIn(drawing.source).length, drawing.where).toBeLessThanOrEqual(12);
      for (const line of labelLinesIn(drawing.source)) {
        expect(line.trim().split(/\s+/).length, `${drawing.where}: ${line}`).toBeLessThanOrEqual(3);
      }
    }
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

async function mount(props: { variant?: "both" | "wide" | "phone"; caption?: string | null } = {}) {
  host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      createElement(
        NextIntlClientProvider,
        { locale: "en", messages: { docs: { close: "Close" } } },
        createElement(DiagramFrame, { svg, ...props }),
      ),
    );
  });
  return host;
}

/** The panel fades out on the way past, so it is still there for a moment. */
async function settle() {
  await act(async () => {
    await new Promise((done) => setTimeout(done, 400));
  });
}

/** A click on the control that opens the drawing over the whole page. */
async function openFull(frame: HTMLElement) {
  await act(async () => {
    frame.querySelector<HTMLButtonElement>("button.docs-diagram-open")?.click();
  });
  return document.querySelector<HTMLElement>('div[role="dialog"]');
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

  it("says which of the two it is, so the stylesheet can pick one by screen width", async () => {
    const wide = await mount({ variant: "wide" });
    expect(wide.querySelector("figure")?.dataset.variant).toBe("wide");
    expect(wide.querySelector("figcaption")).toBeNull();
    host?.remove();

    const phone = await mount({ variant: "phone", caption: "Half two: the re-check." });
    const figure = phone.querySelector("figure");
    expect(figure?.dataset.variant).toBe("phone");
    expect(figure?.querySelector("figcaption")?.textContent).toBe("Half two: the re-check.");
  });

  it("opens the drawing in a panel on the body itself, never inside the page", async () => {
    const frame = await mount();
    const panel = await openFull(frame);
    // A fixed panel inside a transformed ancestor is laid out against that
    // ancestor, not the window, which is how the drawer bug happened.
    expect(panel?.parentElement).toBe(document.body);
    expect(panel?.getAttribute("aria-modal")).toBe("true");
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    await settle();
    expect(document.querySelector('div[role="dialog"]')).toBeNull();
  });

  it("gives the way out a target a thumb can hit", async () => {
    const frame = await mount();
    const panel = await openFull(frame);
    const shut = panel?.querySelector<HTMLButtonElement>("button[data-close]");
    expect(shut?.textContent).toBe("Close");
    // docs-lightbox-control is the 44 px hit area in the stylesheet.
    expect(shut?.className).toContain("docs-lightbox-control");
    await act(async () => {
      shut?.click();
    });
    await settle();
    expect(document.querySelector('div[role="dialog"]')).toBeNull();
  });
});
