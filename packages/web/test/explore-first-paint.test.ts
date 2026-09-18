import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * What the sheet shows before the browser has run the page.
 *
 * A motion component holds its plate at opacity 0 in the served HTML until
 * framer-motion has hydrated it. On a phone that left the first picture painted
 * 4.8 seconds after it had arrived, so the row that is already on screen is
 * drawn without one. This holds both halves of that: the first row is visible in
 * the markup and asks for its picture early, and every plate under it still
 * enters as it is scrolled to.
 */

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@/components/motion/useIsReducedMotion", () => ({ useIsReducedMotion: () => false }));
vi.mock("@/components/explore/load", () => ({ morePlates: vi.fn() }));
vi.mock("@/components/explore/Plate", () => ({
  Plate: ({ plate, first }: { plate: { id: string }; first?: boolean }) =>
    createElement("span", { "data-plate": plate.id, "data-first": String(first === true) }),
}));

const { Grid } = await import("@/components/explore/Grid");

/** Six real pictures, newest first, so the sort leaves them in the order given. */
const PLATES = [...Array(6).keys()].map((index) => ({
  id: `0x${String(index).repeat(64).slice(0, 64)}`,
  kind: 0,
  registeredAt: 1_000 - index,
  title: `Picture ${index}`,
  thumbnailUrl: `ipfs://picture-${index}`,
  manifest: false,
  rechecked: false,
  chainlink: false,
  disputed: false,
  agentId: null,
}));

function sheet() {
  return renderToStaticMarkup(
    createElement(Grid, {
      first: PLATES,
      cursor: null,
      search: { view: "pictures" as const, search: "", agent: null },
      indexError: null,
    }),
  );
}

/** Every plate in the grid, in the order the markup draws them. */
function drawn(html: string): string[] {
  return html.split("<li").slice(1);
}

describe("the row a reader sees before scrolling", () => {
  it("is drawn with nothing hiding it, so the picture counts on the first paint", () => {
    const rows = drawn(sheet());

    for (const row of rows.slice(0, 4)) {
      expect(row).not.toContain("opacity:0");
      expect(row).toContain("rise");
    }
  });

  it("names the two pictures a phone shows for an early fetch, and no more", () => {
    const rows = drawn(sheet());

    expect(rows.slice(0, 2).every((row) => row.includes('data-first="true"'))).toBe(true);
    expect(rows.slice(2).some((row) => row.includes('data-first="true"'))).toBe(false);
  });

  it("leaves every plate under it to enter on scroll", () => {
    const rows = drawn(sheet());

    expect(rows).toHaveLength(6);
    for (const row of rows.slice(4)) {
      expect(row).toContain("opacity:0");
    }
  });
});
