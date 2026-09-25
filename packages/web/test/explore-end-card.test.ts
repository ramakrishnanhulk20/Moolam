import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import en from "@/messages/en.json";
import { EndCard } from "@/components/explore/EndCard";
import { endClasses, endSpans, hasEnd } from "@/components/explore/end";

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; prefetch?: boolean; className?: string; children?: unknown }) =>
    createElement(
      "a",
      { href: props.href, "data-prefetch": String(props.prefetch), className: props.className },
      props.children as never,
    ),
}));

function render(node: ReactElement): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;
  return renderToStaticMarkup(createElement(Provider, { locale: "en", messages: en, timeZone: "Asia/Kolkata" }, node));
}

/**
 * The card that closes a short last row on Explore.
 *
 * The grid shows its line colour through every empty cell, so the card has to
 * cover exactly the cells the last row leaves, at two, three and four columns,
 * and must not exist where the row is full. The case that showed it was 17
 * pictures at four columns: one plate and three grey cells.
 */
describe("the end card's span", () => {
  it("covers what 17 plates leave: one at two columns, one at three, three at four", () => {
    expect(endSpans(17)).toEqual({ base: 1, sm: 1, xl: 3 });
  });

  it("covers what 16 plates leave: none at two, two at three, none at four", () => {
    expect(endSpans(16)).toEqual({ base: 0, sm: 2, xl: 0 });
  });

  it("covers what 18 plates leave: none at two, none at three, two at four", () => {
    expect(endSpans(18)).toEqual({ base: 0, sm: 0, xl: 2 });
  });

  it("is hidden at a column count where the row is full and spans the rest elsewhere", () => {
    expect(endClasses(endSpans(17))).toBe("flex col-span-1 sm:flex sm:col-span-1 xl:flex xl:col-span-3");
    expect(endClasses(endSpans(16))).toBe("hidden sm:flex sm:col-span-2 xl:hidden");
    expect(endClasses(endSpans(18))).toBe("hidden sm:hidden xl:flex xl:col-span-2");
  });

  it("fills every short row exactly, for any count a Load more can reach", () => {
    for (let count = 1; count <= 120; count += 1) {
      const spans = endSpans(count);
      expect((count + spans.base) % 2).toBe(0);
      expect((count + spans.sm) % 3).toBe(0);
      expect((count + spans.xl) % 4).toBe(0);
      expect(spans.base).toBeLessThan(2);
      expect(spans.sm).toBeLessThan(3);
      expect(spans.xl).toBeLessThan(4);
    }
  });

  it("does not exist when the row is full at every column count", () => {
    expect(hasEnd(endSpans(12))).toBe(false);
    expect(render(createElement(EndCard, { count: 12 }))).toBe("");
    expect(render(createElement(EndCard, { count: 24 }))).toBe("");
  });
});

describe("the end card", () => {
  const markup = render(createElement(EndCard, { count: 17 }));

  it("says its two lines", () => {
    expect(markup).toContain(en.explore.invite.line);
    expect(markup).toContain(en.explore.invite.body);
  });

  it("sends Make one to the studio without prefetching it", () => {
    expect(markup).toContain('href="/studio"');
    expect(markup).toContain('data-prefetch="false"');
    expect(markup).toContain(en.explore.invite.make);
  });

  it("uses the home page's solid inverse button", () => {
    const button = markup.slice(markup.indexOf('href="/studio"'));
    expect(button).toContain("bg-text");
    expect(button).toContain("text-bg");
    expect(button).toContain("rounded-[8px]");
  });

  it("carries the span for its count", () => {
    expect(markup).toContain("xl:col-span-3");
  });
});
