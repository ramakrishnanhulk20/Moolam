import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import en from "@/messages/en.json";
import { CHOSEN_CHIP } from "@/components/explore/chip";
import { isTestCard } from "@/components/explore/sort";
import { plateUnread } from "@/components/explore/unread";

/**
 * The judge's walk of 1 October (WO-293a): the pages that slid sideways on a
 * phone, the Explore plates that read as broken pictures, the Verify kicker on
 * the photo and the chosen chip under 4.5:1. Layout itself needs a browser, so it
 * was checked in one. These hold the rules.
 */

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown }) => createElement("a", { href: props.href }, props.children as never),
}));

const WEB = join(__dirname, "..");
const read = (file: string) => readFileSync(join(WEB, file), "utf8");
const stylesheet = read("styles/globals.css");

describe("docs on a phone (row 2)", () => {
  it("lets a bare address or long link in prose break, for every page", () => {
    const rule = /\.docs-prose :is\(p, li, blockquote, h2, h3, h4, dt, dd\) \{([^}]*)\}/.exec(stylesheet)?.[1] ?? "";
    expect(rule).toContain("overflow-wrap: anywhere");
  });

  it("lets a long word in a wide table's phone card break in plain text as well as in code", () => {
    const phone = stylesheet.slice(stylesheet.indexOf("/* On a phone a wide table stops being a grid"));
    expect(phone).toMatch(/\.docs-table-wide td,\s*\.docs-table-wide td code \{\s*overflow-wrap: anywhere;/);
  });
});

describe("/business on a phone (row 3)", async () => {
  const { Security } = await import("@/components/business/Sections");
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{ locale: string; messages: unknown }>;
  const markup = renderToStaticMarkup(
    createElement(
      Provider,
      { locale: "en", messages: en },
      createElement(Security, { number: "07", tally: { attacks: 78, refused: 73, controls: 5, findings: 0 } }),
    ),
  );

  it("sets the three figures one to a line below 640 px, each with its words beside it", () => {
    const list = /<dl class="([^"]*)"/.exec(markup)?.[1].split(/\s+/) ?? [];
    expect(list).toContain("grid-cols-1");
    expect(list).toContain("sm:grid-cols-3");
    const items = [...markup.matchAll(/<dl[^>]*>([\s\S]*?)<\/dl>/g)][0]?.[1] ?? "";
    const rows = [...items.matchAll(/<div class="([^"]*)"/g)].map((match) => match[1].split(/\s+/));
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row).toContain("grid-cols-[minmax(3.25rem,auto)_minmax(0,1fr)]");
      expect(row).toContain("sm:flex");
      expect(row).toContain("sm:flex-col-reverse");
    }
  });

  it("keeps the section heading's column no wider than the page", () => {
    const head = /<div[^>]*class="(mb-10 grid[^"]*)"/.exec(markup)?.[1].split(/\s+/) ?? [];
    expect(head).toContain("grid-cols-1");
  });
});

describe("Explore's untitled records with nothing on a gateway (row 13)", () => {
  const ID = `0x${"7b".repeat(32)}`;
  const none = { missing: true } as const;

  it("waits only on a record a gateway could still hand over", () => {
    expect(plateUnread("ipfs://bafkreiexample", none)).toBe(true);
    expect(plateUnread('data:application/json,{"name":"signed.jpg"}', none)).toBe(false);
    expect(plateUnread("", null)).toBe(false);
    expect(plateUnread("ipfs://bafkreiexample", { title: "Harbour", missing: false })).toBe(false);
  });

  it("so an untitled data: record is a test image and a slow pinned one keeps its place", () => {
    expect(isTestCard(null, ID, plateUnread('data:application/json,{"name":"strip-metadata.jpg"}', none))).toBe(true);
    expect(isTestCard(null, ID, plateUnread("ipfs://bafkreiexample", none))).toBe(false);
  });
});

describe("the Verify kicker (row 23)", () => {
  it("sits on a solid plate of the page's ground, in both themes", () => {
    const card = read("components/verify/AnswerCard.tsx");
    const kicker = /data-still-kicker\s+className="([^"]*)"/.exec(card)?.[1].split(/\s+/) ?? [];
    expect(kicker).toContain("bg-bg");
    expect(kicker).toContain("rounded-[8px]");
    expect(kicker.some((name) => name.startsWith("[.light_&]:") || name.startsWith("bg-bg/"))).toBe(false);
  });
});

describe("the chosen chip on Explore (row 27)", () => {
  const hex = (value: string) => [1, 3, 5].map((at) => Number.parseInt(value.slice(at, at + 2), 16));
  const lum = (rgb: number[]) =>
    rgb
      .map((v) => v / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
      .reduce((sum, v, at) => sum + v * [0.2126, 0.7152, 0.0722][at], 0);
  const mix = (a: number[], b: number[], share: number) => a.map((v, at) => v * share + b[at] * (1 - share));
  const ratio = (a: number[], b: number[]) => {
    const [x, y] = [lum(a), lum(b)];
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };

  it("reads at 4.5:1 or better on its tint in light", () => {
    const accent = hex(/\.light \{[\s\S]*?--accent: (#[0-9a-f]{6})/i.exec(stylesheet)?.[1] ?? "");
    const ground = hex(/\.light \{[\s\S]*?--bg: (#[0-9a-f]{6})/i.exec(stylesheet)?.[1] ?? "");
    const share = Number(/var\(--accent\)_(\d+)%,black/.exec(CHOSEN_CHIP)?.[1]) / 100;
    const tint = mix(accent, ground, 0.12);
    expect(ratio(accent, tint)).toBeLessThan(4.5);
    expect(ratio(mix(accent, [0, 0, 0], share), tint)).toBeGreaterThanOrEqual(4.5);
  });

  it("is the one class every chosen chip on Explore wears", () => {
    for (const file of ["components/explore/Filters.tsx", "components/explore/NoMatch.tsx"]) {
      const source = read(file);
      expect(source).toContain("CHOSEN_CHIP");
      expect(source).not.toContain("bg-accent-soft text-accent");
    }
  });
});
