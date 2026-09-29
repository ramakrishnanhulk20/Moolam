import { NextIntlClientProvider } from "next-intl";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { shownHeaderHeight } from "@/components/docs/HeaderOffset";
import { renderPage } from "@/lib/docs/render";
import en from "@/messages/en.json";

/**
 * The docs polish pass: the bar that has to stay under the header that is
 * really on screen, the wide tables of the Proof page, and the room a diagram
 * holds while it draws. Each is checked on the server output a reader's browser
 * receives, with no browser here to lay it out.
 */

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown }) =>
    createElement("a", { href: props.href }, props.children as never),
  useRouter: () => ({ push: () => undefined }),
  usePathname: () => "/docs",
}));

function box(height: number) {
  return { getBoundingClientRect: () => ({ height }) };
}

async function markup(slug: string, body: string): Promise<string> {
  const { content } = await renderPage(slug, body);
  return renderToStaticMarkup(
    createElement(NextIntlClientProvider, { locale: "en", messages: en }, content as ReactElement),
  );
}

const WIDE = [
  "| Claim | See it | File | Test or run |",
  "| --- | --- | --- | --- |",
  "| A primitive | Contracts | `packages/contracts/src/MoolamRegistry.sol` | `test_renouncingOwnershipLocksOut` |",
  "| Survives re-encoding | Verify | `packages/verifier/src/fingerprint.ts` | `npm run prove` |",
].join("\n");

const NARROW = [
  "| Path | What it holds |",
  "| --- | --- |",
  "| `packages/contracts/src/MoolamRegistry.sol` | The registry |",
].join("\n");

describe("the docs bar offset", () => {
  it("measures the header on screen, not the phone header hidden in front of it", () => {
    // The layout lists the phone header first; from 768 px up it is hidden and
    // measures 0, which is how the docs bar slid under the laptop header.
    expect(shownHeaderHeight([box(0), box(63)])).toBe(63);
  });

  it("takes the phone header when that is the one showing", () => {
    expect(shownHeaderHeight([box(57), box(0)])).toBe(57);
  });

  it("publishes 0 when no header is showing at all", () => {
    expect(shownHeaderHeight([box(0), box(0)])).toBe(0);
    expect(shownHeaderHeight([])).toBe(0);
  });
});

describe("a table of four or more columns", () => {
  it("labels every body cell with its column, so a phone can print it above the cell", async () => {
    const html = await markup("test/polish-wide", WIDE);
    expect(html).toContain('class="docs-table docs-table-wide"');
    const cells = [...html.matchAll(/<td[^>]*>/g)].map((hit) => hit[0]);
    expect(cells).toHaveLength(8);
    for (const cell of cells) {
      expect(cell).toMatch(/data-label="(Claim|See it|File|Test or run)"/);
    }
    expect(cells[2]).toContain('data-label="File"');
    expect(cells[3]).toContain('data-label="Test or run"');
  });

  it("lets a path break after each slash and a name at each joint, and nowhere else", async () => {
    const html = await markup("test/polish-wide-code", WIDE);
    expect(html).toContain("<code>packages/<wbr/>contracts/<wbr/>src/<wbr/>Moolam<wbr/>Registry.sol</code>");
    expect(html).toContain("<code>test_<wbr/>renouncing<wbr/>Ownership<wbr/>Locks<wbr/>Out</code>");
    // The break chances are markup only: the words a reader copies are unchanged.
    expect(html.replace(/<wbr\/>/g, "")).toContain("packages/contracts/src/MoolamRegistry.sol");
  });
});

describe("a table of two columns", () => {
  it("keeps today's look: no labels and no break chances", async () => {
    const html = await markup("test/polish-narrow", NARROW);
    expect(html).toContain('<div class="docs-table">');
    expect(html).not.toContain("docs-table-wide");
    expect(html).not.toContain("data-label");
    expect(html).not.toContain("<wbr");
  });
});

describe("a diagram's height hint", () => {
  it("holds the finished height in the placeholder while mermaid draws", async () => {
    const html = await markup("test/polish-diagram", "```mermaid height=620\nflowchart LR\n  A --> B\n```");
    expect(html).toMatch(/<figure class="docs-diagram docs-diagram-held"[^>]*style="height:620px"/);
  });

  it("reads the hint on a phone redraw after its quoted line", async () => {
    const html = await markup(
      "test/polish-diagram-pair",
      '```mermaid height=459\nflowchart LR\n  A --> B\n```\n\n```mermaid phone "Half one: the start." height=470\nflowchart TD\n  A --> B\n```',
    );
    // The wide half is drawn on this server render; the phone half is not, since
    // the server has no narrow screen. The wide one keeps its own hint through
    // the pairing pass that rewrites its fence.
    expect(html).toMatch(/data-variant="wide"[^>]*style="height:459px"/);
  });

  it("leaves a fence with no hint at the waiting line's own height", async () => {
    const html = await markup("test/polish-diagram-plain", "```mermaid\nflowchart LR\n  A --> B\n```");
    expect(html).toContain('class="docs-diagram docs-diagram-held"');
    expect(html).not.toMatch(/style="height:/);
  });
});
