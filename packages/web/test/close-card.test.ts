import { readFileSync, readdirSync } from "node:fs";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import en from "@/messages/en.json";
import ta from "@/messages/ta.json";
import { CloseCard } from "@/components/story/CloseCard";
import type { StoryData } from "@/components/story/data";

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; prefetch?: boolean; className?: string; children?: unknown }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
}));

function render(locale: "en" | "ta", node: ReactElement): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;

  return renderToStaticMarkup(
    createElement(Provider, { locale, messages: locale === "en" ? en : ta, timeZone: "Asia/Kolkata" }, node),
  );
}

const data: StoryData = {
  source: "envio",
  plates: [],
  focal: null,
  attestation: null,
  agent: null,
  statement: null,
  statementError: null,
  passportCount: 37,
  attestationCount: 15,
  error: null,
};

/**
 * The three ways out of the film's last screen.
 *
 * The two calls are buttons. The third is the evidence, and it rides on the
 * line that names the chain rather than in the row above it: at 375 px that
 * row is already 330 of 335 px wide in Portuguese, so a third item there wraps
 * and drags the card's last line towards the fold.
 */
describe("the film's last screen", () => {
  const markup = render("en", createElement(CloseCard, { data, pinned: false }));

  it("offers the studio, the verify screen and the proof", () => {
    expect(markup).toContain('href="/studio"');
    expect(markup).toContain('href="/verify"');
    expect(markup).toContain('href="/docs/proof"');
  });

  it("puts the proof link on the chain line and not in the row of calls", () => {
    const row = markup.slice(markup.indexOf('href="/studio"'), markup.indexOf('href="/docs/proof"'));
    expect(row).toContain('href="/verify"');
    expect(row).toContain("<dl");
  });

  it("reaches it from a keyboard, as an anchor with words in it", () => {
    // .tap hangs an invisible 44 px pad off the small link (WO-217, F15).
    expect(markup).toContain(`<a href="/docs/proof" class="tap transition-colors duration-200 hover:text-accent focus-visible:text-accent">${en.story.close.proof}</a>`);
  });

  it("carries the reader's own words for it", () => {
    expect(render("ta", createElement(CloseCard, { data, pinned: false }))).toContain(ta.story.close.proof);
  });
});

describe("the proof link in ten languages", () => {
  const locales = readdirSync("messages")
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.replace(".json", ""));

  it("is ten message files", () => {
    expect(locales.length).toBe(10);
  });

  it("carries story.close.proof in all ten, and says so", () => {
    let found = 0;
    for (const locale of locales) {
      const messages = JSON.parse(readFileSync(`messages/${locale}.json`, "utf8")) as {
        story: { close: Record<string, string> };
      };
      const words = messages.story.close.proof;
      expect(typeof words, `${locale}.story.close.proof`).toBe("string");
      expect(words.trim().length, `${locale}.story.close.proof`).toBeGreaterThan(0);
      found += 1;
    }
    expect(found).toBe(10);
  });
});
