import { describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";
import ta from "@/messages/ta.json";
import { HeroCredits } from "@/components/story/HeroCredits";

type Target = { pathname: string; query?: Record<string, string> } | string;

const asked = vi.hoisted(() => [] as { href: unknown; prefetch: boolean | undefined }[]);

// next-intl's navigation helpers reach for next/navigation, which only resolves
// inside the bundler. The block asks it for one link with a query on it, so the
// stand-in keeps what it was handed and writes the address a browser would get.
vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: Target; prefetch?: boolean; className?: string; children?: unknown }) => {
    asked.push({ href: props.href, prefetch: props.prefetch });
    const href =
      typeof props.href === "string"
        ? props.href
        : `${props.href.pathname}?${new URLSearchParams(props.href.query ?? {}).toString()}`;
    return createElement("a", { href, className: props.className }, props.children as never);
  },
}));

function render(locale: "en" | "ta", node: ReactElement): string {
  // The provider's own props type demands children, which createElement passes
  // as an argument rather than a prop.
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;

  return renderToStaticMarkup(
    createElement(Provider, { locale, messages: locale === "en" ? en : ta, timeZone: "Asia/Kolkata" }, node),
  );
}

/**
 * The first screen's credit block: the two calls a reader is offered before a
 * word of the story has been scrolled. What matters is that both addresses are
 * in the markup whether the entrance has run or not, so a reader whose
 * JavaScript never arrives still has somewhere to go.
 */
describe("the hero credit block", () => {
  it("carries the label and both addresses once it has entered", () => {
    asked.length = 0;
    const markup = render("en", createElement(HeroCredits, { entered: true }));

    expect(markup).toContain("Make one, or check one");
    expect(markup).toContain("Generate an image");
    expect(markup).toContain("Verify a copy");
    expect(markup).toContain('href="/studio?mode=generate"');
    expect(markup).toContain('href="/verify"');

    expect(asked).toEqual([
      { href: { pathname: "/studio", query: { mode: "generate" } }, prefetch: false },
      { href: "/verify", prefetch: undefined },
    ]);
  });

  it("holds the same links at opacity 0 before the entrance runs", () => {
    const markup = render("en", createElement(HeroCredits, { entered: false }));

    expect(markup).toContain("Make one, or check one");
    expect(markup).toContain("Generate an image");
    expect(markup).toContain("Verify a copy");
    expect(markup).toContain('href="/studio?mode=generate"');
    expect(markup).toContain('href="/verify"');

    // Two blocks waiting: the label and the row of buttons, each already at the
    // size and place it will settle at, which is what keeps the page still.
    expect(markup.match(/opacity:0/g)).toHaveLength(2);
    expect(markup).toContain("translateY(28px)");
    expect(markup).not.toContain("story-enter");
  });

  it("plays the label first and the buttons behind it", () => {
    const markup = render("en", createElement(HeroCredits, { entered: true }));

    expect(markup.match(/story-enter/g)).toHaveLength(2);
    expect(markup).toContain("animation-delay:100ms");
  });

  it("reads the label in the page's own language", () => {
    const markup = render("ta", createElement(HeroCredits, { entered: true }));

    expect(markup).toContain(ta.home.hero.credit);
    expect(markup).toContain(ta.home.hero.generate);
    expect(markup).toContain(ta.home.hero.verify);
    expect(markup).not.toContain(en.home.hero.credit);
  });

  it("lets a pointer through to the two links and nowhere else", () => {
    const markup = render("en", createElement(HeroCredits, { entered: true }));

    expect(markup).toContain("pointer-events-none w-fit");
    expect(markup.match(/pointer-events-auto/g)).toHaveLength(2);
  });
});
