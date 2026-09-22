import { describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";
import type { ExplorePlate } from "@/components/explore/sort";

/**
 * A sealed passport on the Explore sheet.
 *
 * The sheet is where a stranger meets the registry, so this is where a sealed
 * record is most likely to be misread as one whose picture failed to load. It
 * gets the block hash drawn, a fourth mark that says sealed out loud, and the
 * word beside the date.
 */

const link = vi.hoisted(() => ({ pending: false }));

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
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

const { Plate } = await import("@/components/explore/Plate");
const { Filters } = await import("@/components/explore/Filters");

const BLOCKHASH = "0x001e003e37fc17ff003e00de16fe07ff07ff83fe03901f90c3f387e00ff007f0";

const published: ExplorePlate = {
  id: `0x${"1a".repeat(32)}`,
  kind: 0,
  registeredAt: 1_788_876_082,
  title: "Monsoon fishing nets drying",
  thumbnailUrl: "ipfs://picture-1",
  manifest: true,
  rechecked: true,
  chainlink: false,
  disputed: false,
  agentId: "10248",
  consent: null,
};

const sealed: ExplorePlate = {
  ...published,
  title: "Monsoon nets, Kovalam",
  thumbnailUrl: null,
  manifest: false,
  rechecked: false,
  sealed: true,
  blockhash: BLOCKHASH,
};

function render(node: ReactElement): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;
  return renderToStaticMarkup(createElement(Provider, { locale: "en", messages: en, timeZone: "Asia/Kolkata" }, node));
}

describe("a sealed plate on the sheet", () => {
  it("draws the block hash instead of a picture, and never the gateway's words", () => {
    const markup = render(createElement(Plate, { plate: sealed }));

    expect(markup).not.toContain(en.explore.noPicture);
    expect(markup).not.toContain("data-picture");
    expect(markup.match(/<span class="bg-text"/g)?.length).toBeGreaterThan(30);
  });

  it("carries the fourth mark, read out as what it means", () => {
    const markup = render(createElement(Plate, { plate: sealed }));

    expect(markup).toContain(`aria-label="${en.explore.sealed.mark}"`);
    expect(markup).toContain(">S<");
  });

  it("says the word beside the date, for a reader who is hovering nothing", () => {
    const markup = render(createElement(Plate, { plate: sealed }));

    expect(markup).toContain(en.explore.sealed.word);
    expect(markup).toContain(sealed.title as string);
  });

  it("leaves a published plate as it was, with an unlit S that says nothing", () => {
    const markup = render(createElement(Plate, { plate: published }));

    expect(markup).toContain("data-picture");
    expect(markup).not.toContain(en.explore.sealed.mark);
    expect(markup).not.toContain(en.explore.sealed.word);
  });

  it("still shows the gateway's own words for a published plate with no thumbnail", () => {
    const markup = render(createElement(Plate, { plate: { ...published, thumbnailUrl: null } }));

    expect(markup).toContain(en.explore.noPicture);
    expect(markup).not.toContain(en.explore.sealed.word);
  });
});

describe("the legend under the chips", () => {
  it("teaches the fourth letter along with the other three", () => {
    const markup = render(
      createElement(Filters, { search: { view: "pictures" as const, search: "", agent: null, ai: null } }),
    );

    expect(markup).toContain(`<span class="text-accent">S</span> ${en.explore.sealed.legend}`);
  });
});
