// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextIntlClientProvider } from "next-intl";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CodeBlock, copyText } from "@/components/docs/CodeBlock";
import { DiagramFrame } from "@/components/docs/DiagramFrame";
import { OnThisPage } from "@/components/docs/OnThisPage";
import { DIAGRAM_SCALE_FLOOR, diagramScale, diagramWidth, drawnSize } from "@/lib/docs/diagram";
import { readPage } from "@/lib/docs/pages";
import { renderPage } from "@/lib/docs/render";
import en from "@/messages/en.json";

/**
 * The docs follow-ups: a wide diagram stays readable in the page, a wide table
 * never passes over the "On this page" rail, and a refused clipboard says so.
 * Layout itself needs a browser; these check the rules and the markup that the
 * browser is handed.
 */

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown }) =>
    createElement("a", { href: props.href }, props.children as never),
  useRouter: () => ({ push: () => undefined }),
  usePathname: () => "/docs",
}));

function withWords(child: ReactElement): ReactElement {
  return createElement(NextIntlClientProvider, { locale: "en", messages: en }, child);
}

const stylesheet = readFileSync(join(__dirname, "..", "styles", "globals.css"), "utf8");

/** The body of the first @media block for this query that holds the given text. */
function mediaBlockWith(query: string, needle: string): string {
  let from = 0;
  for (;;) {
    const at = stylesheet.indexOf(`@media ${query}`, from);
    if (at === -1) {
      return "";
    }
    let depth = 0;
    let end = at;
    for (let i = stylesheet.indexOf("{", at); i < stylesheet.length; i += 1) {
      if (stylesheet[i] === "{") depth += 1;
      if (stylesheet[i] === "}") depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
    const block = stylesheet.slice(at, end + 1);
    if (block.includes(needle)) {
      return block;
    }
    from = end;
  }
}

/** The declarations of one rule inside a block, found by its exact selector. */
function ruleBody(block: string, selector: string): string {
  const at = block.indexOf(`${selector} {`);
  if (at === -1) {
    return "";
  }
  return block.slice(at + selector.length + 2, block.indexOf("}", at));
}

async function mountFrame(svg: string, variant: "wide" | "phone"): Promise<HTMLDivElement> {
  const box = document.createElement("div");
  document.body.append(box);
  const root = createRoot(box);
  await act(async () => {
    root.render(withWords(createElement(DiagramFrame, { svg, variant })));
  });
  return box;
}

describe("a wide diagram in the page", () => {
  beforeAll(() => {
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  it("fits the frame's width only while the scale stays at the floor or above", () => {
    expect(DIAGRAM_SCALE_FLOOR).toBe(0.6);
    // The system overview in its laptop frame: fitting it would be 0.25.
    expect(diagramScale(2868, 705)).toBe(0.6);
    expect(diagramScale(2868, 1280)).toBe(0.6);
    // Fitting a drawing a little wider than the frame keeps it above the floor.
    expect(diagramScale(1000, 705)).toBeCloseTo(0.705, 3);
    // A drawing that already fits keeps its own size and is never blown up.
    expect(diagramScale(500, 705)).toBe(1);
  });

  it("writes that rule as one width the browser settles on the first paint", () => {
    expect(diagramWidth(2868)).toBe("clamp(1720.8px, 100%, 2868px)");
    expect(drawnSize('<svg aria-roledescription="flowchart" viewBox="-8 -8 2868 1588" width="2868">')).toEqual({
      width: 2868,
      height: 1588,
    });
    expect(drawnSize('<svg width="1400" height="300">')).toEqual({ width: 1400, height: 300 });
    expect(drawnSize("<div></div>")).toBeNull();
  });

  it("puts the floor on a wide drawing and leaves a phone redraw to mermaid", async () => {
    const svg = '<svg width="2868" height="1588" viewBox="0 0 2868 1588"></svg>';
    const wide = await mountFrame(svg, "wide");
    expect(wide.querySelector<HTMLElement>(".docs-diagram-ink")?.style.width).toBe("clamp(1720.8px, 100%, 2868px)");
    // The fade, the hint and Open full size are all still in the frame.
    expect(wide.querySelector(".docs-diagram-fade")).not.toBeNull();
    expect(wide.querySelector(".docs-diagram-hint")).not.toBeNull();
    expect(wide.querySelector("button.docs-diagram-open")?.textContent).toBe("Open full size");
    wide.remove();

    const phone = await mountFrame('<svg viewBox="0 0 340 900"></svg>', "phone");
    expect(phone.querySelector(".docs-diagram-ink")?.hasAttribute("style")).toBe(false);
    phone.remove();
  });

  it("keeps Open full size in reach down a drawing taller than the window", () => {
    const head = ruleBody(stylesheet, ".docs-diagram-head");
    expect(head).toContain("position: sticky");
    expect(ruleBody(stylesheet, '.docs-diagram:not([data-variant="phone"]) .docs-diagram-ink[style] svg')).toContain(
      "max-width: none",
    );
  });
});

describe("a page with a wide table from 1280 px up", () => {
  const headings = [{ id: "the-track", text: "The track", depth: 2 as const }];

  it("marks the rail and the fold so the stylesheet can swap them", () => {
    const rail = renderToStaticMarkup(withWords(createElement(OnThisPage, { headings, variant: "rail" })));
    const fold = renderToStaticMarkup(withWords(createElement(OnThisPage, { headings, variant: "fold" })));
    expect(rail).toMatch(/<aside class="docs-rail /);
    expect(fold).toMatch(/<details class="docs-fold /);
  });

  it("hides the rail, gives the article its column, and shows the fold instead", () => {
    const block = mediaBlockWith("(min-width: 1280px)", ".docs-table-wide");
    expect(block).not.toBe("");
    expect(ruleBody(block, "[data-docs-article]:has(.docs-table-wide) ~ .docs-rail")).toContain("display: none");
    expect(ruleBody(block, "[data-docs-article]:has(.docs-table-wide)")).toContain("grid-column: 1 / -1");
    expect(ruleBody(block, "[data-docs-article]:has(.docs-table-wide) .docs-fold")).toContain("display: block");
    // The table ends where the article ends, never reaching past it.
    const table = ruleBody(block, ".docs-table-wide");
    expect(table).toContain("width: 100cqw");
    expect(table).not.toContain("16rem");
  });

  it("applies to the Proof page, whose tables have five columns", async () => {
    const page = readPage("proof");
    expect(page).not.toBeNull();
    const { content } = await renderPage("proof", page?.body ?? "");
    const html = renderToStaticMarkup(withWords(content));
    expect(html).toContain('class="docs-table docs-table-wide"');
    // The first render of a long page warms the highlighter, which takes a while.
  }, 60_000);

  it("leaves a page of narrow tables with its rail", async () => {
    const narrow = ["| Name | Address |", "| --- | --- |", "| Registry | `0xa191` |"].join("\n");
    const { content } = await renderPage("followups/narrow", narrow);
    const html = renderToStaticMarkup(withWords(content));
    expect(html).toContain('class="docs-table"');
    expect(html).not.toContain("docs-table-wide");
  });
});

describe("the Copy button on a code block", () => {
  let host: HTMLDivElement | null = null;

  afterEach(() => {
    host?.remove();
    host = null;
  });

  it("reports a refused or missing clipboard as a failure", async () => {
    await expect(copyText("npm run prove", { writeText: () => Promise.reject(new Error("denied")) })).resolves.toBe(
      "failed",
    );
    await expect(copyText("npm run prove", undefined)).resolves.toBe("failed");
    await expect(copyText("npm run prove", { writeText: () => Promise.resolve() })).resolves.toBe("copied");
  });

  it("shows the failure line when the browser refuses the clipboard", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new DOMException("Write permission denied.", "NotAllowedError")) },
    });
    host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(withWords(createElement(CodeBlock, { code: "npm run prove" }, "npm run prove")));
    });
    const status = host.querySelector('[role="status"]');
    expect(status?.textContent).toBe("");

    await act(async () => {
      host?.querySelector<HTMLButtonElement>("button.docs-copy")?.click();
    });
    expect(status?.textContent).toBe(en.common.copyFailed);
    expect(host.querySelector("button.docs-copy")?.textContent).toBe(en.docs.copy);
    await act(async () => root.unmount());
  });
});
