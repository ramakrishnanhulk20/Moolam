import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";
import { DEFAULT_SEARCH, type ExploreSearch } from "@/components/explore/query";
import { mergePlates, type ExplorePlate } from "@/components/explore/sort";

/**
 * Explore, pressed.
 *
 * Four things a reader met on 2026-09-28: All after Test images kept the test
 * cards and lost Load more, Load more put new plates above the ones already
 * read, an id read 0X in capitals, and a pressed plate gave no sign for over a
 * second. The seal on a plate with no picture sitting under its title is held
 * here by the classes that keep it in the flow.
 */

const link = vi.hoisted(() => ({ pending: false }));

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown; className?: string; "data-plate"?: string }) =>
    createElement(
      "a",
      { href: props.href, className: props.className, "data-plate": props["data-plate"] },
      props.children as never,
    ),
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: (props: { href: string; children?: unknown }) =>
    createElement("a", { href: props.href }, props.children as never),
  useLinkStatus: () => link,
}));

vi.mock("@/components/passport/Picture", () => ({
  Picture: () => createElement("span", { "data-picture": "true" }),
}));

vi.mock("next/server", async (real) => ({
  ...(await real<typeof import("next/server")>()),
  connection: vi.fn(),
}));
vi.mock("@/components/explore/plates", () => ({ sheetPage: vi.fn(), heldPictureSplit: vi.fn() }));
vi.mock("@/lib/data/passports", () => ({ heldRegistryCounts: vi.fn() }));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (key: string) => key }));

const { sheetKey } = await import("@/components/explore/Sheet");
const { Plate } = await import("@/components/explore/Plate");

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
}

function render(node: ReactElement): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;
  return renderToStaticMarkup(createElement(Provider, { locale: "en", messages: en, timeZone: "UTC" }, node));
}

/** The opening tag of the first element carrying the attribute, with escaped ampersands read back. */
function tagOf(markup: string, attribute: string): string {
  const at = markup.indexOf(attribute);
  expect(at, attribute).toBeGreaterThan(-1);
  const opens = markup.lastIndexOf("<", at);
  return markup.slice(opens, markup.indexOf(">", at) + 1).replaceAll("&amp;", "&");
}

function plate(id: string, registeredAt: number, title: string | null): ExplorePlate {
  return {
    id,
    kind: 0,
    registeredAt,
    title,
    thumbnailUrl: "ipfs://picture",
    manifest: true,
    rechecked: false,
    chainlink: false,
    disputed: false,
    agentId: null,
    consent: null,
  };
}

const ID = "0x3d41c6960a1486e29a85febcdfe282fafcbe33b558fd47578f99cb2f55f70c91";

describe("the key a sheet mounts its grid under", () => {
  const base: ExploreSearch = { ...DEFAULT_SEARCH };

  it("is the same for the same search, however it was built", () => {
    expect(sheetKey(base)).toBe(sheetKey({ view: "pictures", search: "", agent: null, ai: null }));
  });

  it("changes with each field a reader can change", () => {
    const changed: ExploreSearch[] = [
      { ...base, view: "all" },
      { ...base, view: "test" },
      { ...base, search: "0x3d41" },
      { ...base, agent: "10249" },
      { ...base, ai: "closed" },
    ];
    const keys = new Set([base, ...changed].map(sheetKey));
    expect(keys.size).toBe(changed.length + 1);
  });

  it("keeps Test images and All apart, the pair that kept the old grid", () => {
    expect(sheetKey({ ...base, view: "test" })).not.toBe(sheetKey({ ...base, view: "all" }));
  });

  it("cannot be fooled by a search term that carries a separator", () => {
    expect(sheetKey({ ...base, search: "a", agent: "b" })).not.toBe(sheetKey({ ...base, search: "a|b", agent: null }));
    expect(sheetKey({ ...base, search: "", agent: null })).not.toBe(sheetKey({ ...base, search: "null" }));
  });

  it("is the key the sheet hands its grid", () => {
    expect(source("components/explore/Sheet.tsx")).toContain("<Grid key={sheetKey(search)}");
  });
});

describe("the next page under the plates already read", () => {
  it("keeps every held plate where it was, even a test card above a real picture", () => {
    const held = [plate("0x10", 900, "Moolam seed 3"), plate("0x11", 800, "Moolam seed 2")];
    const merged = mergePlates(held, [plate("0x01", 100, "Marina at dusk"), plate("0x02", 200, "Kite sellers")]);

    expect(merged.slice(0, 2)).toEqual(held);
    expect(merged.map((row) => row.id)).toEqual(["0x10", "0x11", "0x02", "0x01"]);
  });

  it("orders the new page among itself only, real pictures first and newest first", () => {
    const held = [plate("0x10", 50, "Marina at dusk")];
    const merged = mergePlates(held, [
      plate("0x20", 300, "Moolam seed 9"),
      plate("0x21", 100, "Old lighthouse"),
      plate("0x22", 200, "Harbour"),
    ]);

    expect(merged.map((row) => row.id)).toEqual(["0x10", "0x22", "0x21", "0x20"]);
  });

  it("never shows a plate twice, whether it was held or repeated in the page", () => {
    const held = [plate("0x10", 300, "Harbour"), plate("0x11", 200, "Marina")];
    const merged = mergePlates(held, [
      plate("0x11", 200, "Marina"),
      plate("0x12", 100, "Nets"),
      plate("0x12", 100, "Nets"),
    ]);

    expect(merged.map((row) => row.id)).toEqual(["0x10", "0x11", "0x12"]);
  });

  it("leaves the held list untouched", () => {
    const held = [plate("0x10", 300, "Harbour")];
    mergePlates(held, [plate("0x11", 400, "Newer")]);
    expect(held.map((row) => row.id)).toEqual(["0x10"]);
  });
});

describe("a plate's id", () => {
  it("is set in lower case inside a row of capitals", () => {
    const markup = render(createElement(Plate, { plate: { ...plate(ID, 1_789_000_000, "Humans Vs AI") } }));
    const id = tagOf(markup, "data-plate-id");

    expect(id).toContain("normal-case");
    expect(markup).toMatch(/<span data-plate-id="true" class="normal-case">0x3d41c6…0c91<\/span>/);
    expect(markup).not.toContain("0X3D41C6");
  });
});

describe("a plate with no picture", () => {
  const markup = render(createElement(Plate, { plate: { ...plate(ID, 1_789_000_000, null), thumbnailUrl: null } }));

  it("puts the seal in the flow, never over the whole plate", () => {
    const seal = tagOf(markup, "data-plate-seal=");
    expect(seal).toContain("relative");
    expect(seal).toContain("flex-1");
    expect(seal).not.toContain("absolute");
    expect(seal).not.toContain("inset-0");
    expect(markup).toContain(en.explore.noPicture);
  });

  it("turns the plate into a column around it, marks first and the title last", () => {
    const whole = tagOf(markup, "data-plate=");
    expect(whole).toContain("has-[[data-plate-seal]]:flex-col");
    expect(whole).toContain("has-[[data-plate-seal]]:overflow-visible");
    expect(tagOf(markup, "data-plate-top=")).toContain("group-has-[[data-plate-seal]]:order-first");
    expect(tagOf(markup, "data-plate-top=")).toContain("group-has-[[data-plate-seal]]:relative");
    expect(tagOf(markup, "data-plate-foot")).toContain("group-has-[[data-plate-seal]]:relative");
    expect(markup.indexOf("data-plate-seal=")).toBeLessThan(markup.indexOf("data-plate-foot"));
  });

  it("hands the same seal to the picture as its fallback, for a gateway that fails later", () => {
    expect(source("components/explore/Plate.tsx")).toContain("fallback={seal}");
  });

  it("lets a cell grow to its row, so a picture beside it fills the same height", () => {
    const grid = source("components/explore/Grid.tsx");
    expect(grid).toContain('className="rise flex min-w-0 flex-col bg-bg-raised"');
    expect(grid).toContain('className="flex min-w-0 flex-col bg-bg-raised"');
    expect(tagOf(markup, "data-plate=")).toContain(" grow ");
  });
});

describe("a pressed plate", () => {
  it("says nothing while nobody has pressed it", () => {
    link.pending = false;
    const markup = render(createElement(Plate, { plate: plate(ID, 1_789_000_000, "Humans Vs AI") }));

    expect(markup).not.toContain("data-plate-opening");
    expect(markup).not.toContain("animate-pulse");
  });

  it("steps back and pulses the seal the chips use, with no new words on screen", () => {
    link.pending = true;
    const markup = render(createElement(Plate, { plate: plate(ID, 1_789_000_000, "Humans Vs AI") }));
    link.pending = false;

    expect(tagOf(markup, "data-plate-opening")).toContain("opacity-45");
    expect(markup).toMatch(/<span aria-hidden="true" class="motif [^"]*animate-pulse"/);
    expect(markup).toContain(`<span class="sr-only">${en.explore.reading}</span>`);
  });
});
