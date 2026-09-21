import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";

// next-intl's navigation helpers reach for next/navigation, which only resolves
// inside the bundler. The three ways back are all this page takes from it.
vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown }) =>
    createElement("a", { href: props.href }, props.children as never),
}));

const { default: LocaleError } = await import("@/app/[locale]/error");
const { default: GlobalError } = await import("@/app/global-error");

/** What a render that failed hands the page: a message and a stack, neither of them a visitor's business. */
const BROKEN = Object.assign(new Error("connect ECONNREFUSED 10.0.0.7:8545 rpc token abc123"), { digest: "9f2c11" });

function render(node: ReactElement): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;
  return renderToStaticMarkup(createElement(Provider, { locale: "en", messages: en, timeZone: "UTC" }, node));
}

describe("the page a failed render lands on", () => {
  const markup = render(createElement(LocaleError, { error: BROKEN, reset: () => undefined }));

  it("says what happened in the visitor's own language", () => {
    expect(markup).toContain(en.error.title);
    expect(markup).toContain(en.error.lede);
    expect(markup).toContain(en.error.code);
  });

  it("offers the same three ways back the not-found page offers", () => {
    expect(markup).toContain(en.notFound.explore);
    expect(markup).toContain('href="/explore"');
    expect(markup).toContain('href="/verify"');
    expect(markup).toContain('href="/docs"');
  });

  it("offers one button that tries the page again", () => {
    expect(markup).toContain(en.error.retry);
    expect(markup).toContain("<button");
  });

  it("never prints the error, its digest or anything inside it", () => {
    expect(markup).not.toContain("ECONNREFUSED");
    expect(markup).not.toContain("10.0.0.7");
    expect(markup).not.toContain("abc123");
    expect(markup).not.toContain("9f2c11");
  });
});

describe("the words these pages need, in every language the site serves", () => {
  const MESSAGES = fileURLToPath(new URL("../messages/", import.meta.url));

  it("says the failure page and the two legal links in all ten", () => {
    const files = readdirSync(MESSAGES).filter((name) => name.endsWith(".json"));
    expect(files).toHaveLength(10);

    for (const file of files) {
      const tree = JSON.parse(readFileSync(`${MESSAGES}${file}`, "utf8")) as {
        error: Record<string, string>;
        footer: Record<string, string>;
      };

      expect(tree.error.code, file).toBe("500");
      for (const key of ["title", "lede", "retry"]) {
        expect(tree.error[key]?.length ?? 0, `${file} error.${key}`).toBeGreaterThan(0);
      }
      expect(tree.footer.privacy?.length ?? 0, `${file} footer.privacy`).toBeGreaterThan(0);
      expect(tree.footer.terms?.length ?? 0, `${file} footer.terms`).toBeGreaterThan(0);
    }
  });
});

describe("the page for a failure above every layout", () => {
  const markup = renderToStaticMarkup(createElement(GlobalError, { error: BROKEN, reset: () => undefined }));

  it("carries its own document, in English, with words in it", () => {
    expect(markup).toContain('<html lang="en">');
    expect(markup).toContain("<body");
    expect(markup).toContain("Something broke");
    expect(markup).toContain("Try again");
  });

  it("needs no provider around it: it renders with nothing else mounted", () => {
    expect(markup).toContain('href="/en"');
  });

  it("never prints the error, its digest or anything inside it", () => {
    expect(markup).not.toContain("ECONNREFUSED");
    expect(markup).not.toContain("10.0.0.7");
    expect(markup).not.toContain("abc123");
    expect(markup).not.toContain("9f2c11");
  });
});
