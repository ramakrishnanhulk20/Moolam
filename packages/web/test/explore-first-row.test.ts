import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";
import type { ExploreSearch } from "@/components/explore/query";
import type { ExplorePlate } from "@/components/explore/sort";

/**
 * Explore's first row of pictures on a tablet's first screen and on the All
 * view (WO-232).
 *
 * Measured in a browser on 29 September: at 768 by 1024 the tall opening
 * started the first row at 1,142 px, at 1024 by 768 three plates across ended
 * it at 893, and on the All view at 1440 by 900 the longer order line pushed it
 * to 910. The compact opening now starts at 768 px, the grid is four across
 * from 1024 px, the split and the order line wrap as one, and the reading mark
 * stands on the rule rather than on a blank line of its own. These are the
 * classes that holds on; the phone's values are pinned beside them so the
 * phone's first row stays where it was.
 */

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: Record<string, unknown>) =>
    createElement("a", { href: props.href, className: props.className, "data-plate": props["data-plate"] }, props.children as never),
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: (props: { href: string; children?: unknown }) => createElement("a", { href: props.href }, props.children as never),
  useLinkStatus: () => ({ pending: false }),
}));

vi.mock("@/components/passport/Picture", () => ({
  Picture: () => createElement("span", { "data-picture": "true" }),
}));

vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  const messages = (await import("@/messages/en.json")).default;
  return {
    getTranslations: async (arg?: string | { namespace?: string }) =>
      createTranslator({
        locale: "en",
        messages,
        namespace: (typeof arg === "string" ? arg : arg?.namespace) as never,
      }),
  };
});

const { Masthead } = await import("@/components/explore/Masthead");
const { Filters } = await import("@/components/explore/Filters");
const { Grid } = await import("@/components/explore/Grid");
const { ReadingProvider } = await import("@/components/explore/Reading");

const SEARCH: ExploreSearch = { view: "pictures", search: "", agent: null, ai: null };
const COUNTS = { total: 43, generated: 34, rechecked: 22, stated: 19, capped: false };
const SPLIT = { real: 22, test: 21, scanned: 43, capped: false };

function render(node: ReactElement): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;
  return renderToStaticMarkup(createElement(Provider, { locale: "en", messages: en, timeZone: "UTC" }, node));
}

/** The class list of the first element carrying the attribute. */
function classesOf(markup: string, attribute: string): string[] {
  const at = markup.indexOf(attribute);
  expect(at, `${attribute} is on the page`).toBeGreaterThan(-1);
  const tag = markup.slice(markup.lastIndexOf("<", at), markup.indexOf(">", at) + 1);
  return (/class="([^"]*)"/.exec(tag)?.[1] ?? "").split(/\s+/);
}

async function masthead(view: ExploreSearch["view"], countsError: string | null = null): Promise<string> {
  return render(
    await Masthead({
      locale: "en",
      counts: countsError === null ? COUNTS : null,
      countsError,
      split: countsError === null ? SPLIT : null,
      view,
    }),
  );
}

function plate(index: number): ExplorePlate {
  return {
    id: `0x${(0xb000 + index).toString(16).padStart(64, "0")}`,
    kind: 0,
    registeredAt: 1_789_000_000 - index,
    title: `Picture ${index}`,
    thumbnailUrl: `https://gateway.example/${index}.png`,
    manifest: false,
    rechecked: false,
    chainlink: false,
    disputed: false,
    agentId: null,
    consent: null,
  };
}

describe("the compact opening from 768 px", () => {
  it("sets the title on one line at 48 px from the tablet up, and the lede beside it only from 1024 px", async () => {
    const markup = await masthead("pictures");
    const title = classesOf(markup, "<h1");
    expect(title).toEqual(expect.arrayContaining(["md:mt-3", "md:whitespace-nowrap", "md:text-[3rem]", "md:max-w-none"]));
    const opening = classesOf(markup, 'data-opening="compact"');
    expect(opening).toEqual(expect.arrayContaining(["md:border-b", "md:pb-6", "lg:grid", "lg:grid-cols-2"]));
    expect(opening.some((name) => name.startsWith("md:grid"))).toBe(false);
  });

  it("keeps the lede at 16 px on a tablet, never smaller", async () => {
    const markup = await masthead("pictures");
    const lede = markup.slice(markup.lastIndexOf("<p", markup.indexOf(en.explore.lede.slice(0, 30))), markup.indexOf(en.explore.lede.slice(0, 30)));
    expect(lede).toContain("text-base");
    expect(lede).toContain("md:text-base");
    expect(lede).not.toMatch(/text-(sm|xs)\b/);
  });

  it("draws the four counts as one strip of figures from 768 px", async () => {
    const markup = await masthead("pictures");
    expect(classesOf(markup, "data-counts-strip")).toEqual(expect.arrayContaining(["md:mt-5", "md:flex", "md:flex-wrap"]));
    expect(classesOf(markup, "data-counts-grid")).toEqual(expect.arrayContaining(["md:flex", "md:gap-x-8"]));
  });

  it("wraps the split and the order line as one, on the pictures view and on the All view", async () => {
    for (const view of ["pictures", "all"] as const) {
      const markup = await masthead(view);
      expect(classesOf(markup, "data-counts-tail")).toEqual(expect.arrayContaining(["md:ms-auto", "md:flex", "md:flex-wrap"]));
      const tail = markup.slice(markup.indexOf("data-counts-tail"));
      const order = view === "all" ? en.explore.sortRule : en.explore.sortNewest;
      expect(tail.indexOf("22 pictures")).toBeGreaterThan(-1);
      expect(tail.indexOf(order)).toBeGreaterThan(tail.indexOf("22 pictures"));
      expect(markup.split(order).length - 1).toBe(1);
    }
  });

  it("still prints the order line once when the counts failed", async () => {
    const markup = await masthead("all", "HTTP request failed");
    expect(markup).not.toContain("data-counts-tail");
    expect(markup.split(en.explore.sortRule).length - 1).toBe(1);
  });

  it("keeps the phone's values under the tablet's", async () => {
    const markup = await masthead("pictures");
    expect(classesOf(markup, "<h1")).toEqual(expect.arrayContaining(["mt-2.5", "text-[clamp(1.75rem,8vw,2.25rem)]"]));
    expect(classesOf(markup, "data-counts-line")).toContain("sm:hidden");
    expect(classesOf(markup, "data-counts-strip")).toContain("mt-2.5");
  });
});

describe("the bar of chips from 768 px", () => {
  it("tightens the bar and folds the AI-use answers behind one chip", () => {
    const markup = render(createElement(Filters, { search: SEARCH }));
    const bar = /<div class="([^"]*border-y border-line[^"]*)"/.exec(markup)?.[1].split(/\s+/) ?? [];
    expect(bar).toEqual(expect.arrayContaining(["relative", "mt-3", "py-2.5", "md:mt-5", "md:py-3"]));
    expect(classesOf(markup, "data-ai-toggle")).toContain("md:inline-flex");
    expect(classesOf(markup, "data-ai-row")).toEqual(expect.arrayContaining(["mt-2", "md:hidden"]));
  });

  it("opens the AI-use row when an answer is narrowing the sheet", () => {
    const markup = render(createElement(Filters, { search: { ...SEARCH, ai: "open" } }));
    expect(classesOf(markup, "data-ai-row")).not.toContain("md:hidden");
  });

  it("stands the reading mark on the rule under the bar, so it takes no line of its own", () => {
    const markup = render(createElement(Filters, { search: SEARCH }));
    const mark = classesOf(markup, "data-reading-mark");
    expect(mark).toEqual(expect.arrayContaining(["md:absolute", "md:bottom-0", "md:end-0", "md:translate-y-1/2", "md:bg-bg"]));
    // On a phone it stays in the row beside the key's toggle, as it was.
    expect(mark).toContain("flex");
    expect(mark).not.toContain("absolute");
  });
});

describe("the grid", () => {
  it("is four across from 1024 px and sits 20 px under the bar from 768 px", () => {
    const markup = render(
      createElement(ReadingProvider, null, createElement(Grid, { first: [0, 1, 2, 3, 4].map(plate), cursor: null, search: SEARCH, indexError: null })),
    );
    const grid = /<ul class="([^"]*)"/.exec(markup)?.[1].split(/\s+/) ?? [];
    expect(grid).toEqual(expect.arrayContaining(["mt-6", "grid-cols-2", "sm:mt-10", "sm:grid-cols-3", "md:mt-5", "lg:grid-cols-4"]));
    expect(grid).not.toContain("xl:grid-cols-4");
  });

  it("starts the page 32 px under the header from 768 px", () => {
    const sheet = readFileSync(new URL("../components/explore/Sheet.tsx", import.meta.url), "utf8");
    expect(sheet).toContain('className="mx-auto w-full max-w-[1400px] px-5 pb-16 pt-4 sm:px-8 sm:py-24 md:pt-8"');
  });
});
