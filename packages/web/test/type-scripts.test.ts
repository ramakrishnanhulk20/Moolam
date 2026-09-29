import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import en from "@/messages/en.json";
import ja from "@/messages/ja.json";
import { TAMIL_HEADING_LEADING, useHeadingLeading } from "@/components/studio/leading";

vi.mock("@/lib/i18n/routing", () => ({
  Link: ({ href, className, children }: { href: string; className?: string; children?: ReactNode }) =>
    createElement("a", { href, className }, children),
}));

const { Headline } = await import("@/components/home/Headline");
const { GuideCard } = await import("@/components/guide/GuideWalk");

/**
 * The per-language type rules are plain CSS that only a browser applies, so this
 * reads the stylesheet as text and pins each selector and value. The pictures
 * that show what they do are in kitchen/reports/ui-polish-2026-09-28/type/scripts.
 */
const css = readFileSync(fileURLToPath(new URL("../styles/globals.css", import.meta.url)), "utf8");

const ruleFor = (selector: string) => {
  const start = css.indexOf(`${selector} {`);
  expect(start, `no rule for ${selector}`).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf("}", start) + 1);
};

describe("Tamil labels and buttons", () => {
  it("lose most of their tracking alongside Hindi, Chinese, Japanese and Korean", () => {
    const scripts = ":where(html:lang(hi), html:lang(zh), html:lang(ja), html:lang(ko), html:lang(ta))";
    expect(ruleFor(`${scripts}\n  :is(.tracking-\\[0\\.24em\\], .tracking-\\[0\\.28em\\]).font-mono.uppercase`)).toContain(
      "letter-spacing: 0.08em;",
    );
    expect(
      ruleFor(`${scripts}\n  :is(.uppercase.tracking-\\[0\\.24em\\]:not(.font-mono), .rounded-\\[8px\\].uppercase)`),
    ).toContain("letter-spacing: 0.06em;");
  });

  it("are not left out of any rule that tames tracking for the other scripts", () => {
    const tamers = css.match(/:where\(html:lang\(hi\)[^{]*\{\s*letter-spacing/g) ?? [];
    expect(tamers.length).toBe(3);
    for (const rule of tamers) expect(rule).toContain("html:lang(ta)");
  });
});

describe("every other tracked-out label", () => {
  const scripts = ":where(html:lang(hi), html:lang(zh), html:lang(ja), html:lang(ko), html:lang(ta))";
  const start = css.indexOf(`${scripts}
  :is(
    .tracking-`);
  const rule = css.slice(start, css.indexOf("}", start) + 1);
  const listed = (rule.match(/:is\(([^)]*)\)/)?.[1] ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);

  it("comes down to 0.06 em in Tamil, Hindi, Chinese, Japanese and Korean", () => {
    expect(start).toBeGreaterThan(-1);
    expect(rule).toContain("letter-spacing: 0.06em;");
  });

  it("covers every tracking from 0.1 em up that a page uses, at any width", () => {
    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(name)) sources.push(readFileSync(full, "utf8"));
      }
    };
    for (const dir of ["components", "app"]) walk(fileURLToPath(new URL(`../${dir}`, import.meta.url)));
    const used = new Set(
      sources.flatMap((source) =>
        [...source.matchAll(/(?<![\w-])((?:[a-z]+:)*)tracking-\[0\.(\d+)em\]/g)]
          .filter((match) => Number(`0.${match[2]}`) >= 0.1)
          .map((match) => String.raw`.${match[1].replace(/:/g, String.raw`\:`)}tracking-\[0\.${match[2]}em\]`),
      ),
    );
    expect(used.size).toBeGreaterThan(10);
    for (const name of used) expect(listed, `${name} is used but not tamed`).toContain(name);
  });

  it("names one class at a time, so the kicker rule at 0.08 em still wins, and sits outside the layers", () => {
    for (const name of listed) expect(name).toMatch(/^\.(?:\\.|[^.\s\\])+$/);
    expect(start).toBeLessThan(css.indexOf("@layer"));
  });
});

describe("the Japanese home headline", () => {
  const headline = (locale: string, messages: typeof en) =>
    renderToStaticMarkup(
      createElement(NextIntlClientProvider, { locale, messages }, createElement(Headline, { size: "board" })),
    ).match(/<h1[^>]*class="([^"]*)"/)?.[1] ?? "";

  it("takes the whole half one step down, as Tamil does, so it sets in three phrases", () => {
    const japanese = headline("ja", ja as typeof en);
    expect(japanese).toContain("max-w-none");
    expect(japanese).toContain("text-[clamp(2.4rem,3.8vw,4.1rem)]");
  });

  it("leaves English on its own measure and size", () => {
    const english = headline("en", en);
    expect(english).toContain("max-w-[15ch]");
    expect(english).toContain("text-[clamp(2.6rem,4.3vw,4.6rem)]");
  });
});

describe("the guide's card in Tamil", () => {
  const card = (locale: string) =>
    renderToStaticMarkup(
      createElement(
        NextIntlClientProvider,
        { locale, messages: en },
        createElement(GuideCard, { index: 1, lit: true, reduced: true, onClose: () => undefined, onForward: () => undefined }),
      ),
    );

  it("gives back air below a laptop so it fits between the headline and Choose an image", () => {
    const tamil = card("ta");
    expect(tamil).toMatch(/class="rounded-\[8px\][^"]* p-3 [^"]*lg:p-5"/);
    expect(tamil).toContain("mt-1.5 leading-normal lg:leading-relaxed text-base");
    expect(tamil).toContain("mt-1 lg:mt-2 font-display");
  });

  it("keeps every other language's card as it was", () => {
    const english = card("en");
    expect(english).toMatch(/class="rounded-\[8px\][^"]* p-4 [^"]*lg:p-5"/);
    expect(english).not.toContain("leading-normal");
  });
});

describe("Tamil display headings", () => {
  it("get one line height at which two lines never touch", () => {
    const rule = ruleFor(":where(html:lang(ta)) .font-display:not(.tabular-nums)");
    expect(rule).toContain("line-height: 1.25;");
  });

  it("get the same number from the heading hook", () => {
    expect(TAMIL_HEADING_LEADING).toBe("leading-[1.25]");
    const Probe = () => createElement("span", null, useHeadingLeading("leading-[0.95]", "leading-[1.35]"));
    const render = (locale: string) =>
      renderToStaticMarkup(createElement(NextIntlClientProvider, { locale, messages: en }, createElement(Probe)));
    expect(render("ta")).toBe("<span>leading-[1.25]</span>");
    expect(render("en")).toBe("<span>leading-[0.95]</span>");
  });
});

describe("Japanese display headings", () => {
  it("break between phrases, with the browser's own breaking as the fallback", () => {
    const rule = ruleFor(":where(html:lang(ja)) .font-display");
    const plain = rule.indexOf("word-break: normal;");
    const phrase = rule.indexOf("word-break: auto-phrase;");
    expect(plain).toBeGreaterThan(-1);
    expect(phrase).toBeGreaterThan(plain);
  });
});

describe("the hand cursor", () => {
  it("shows on every enabled button, button-like control and summary, under the utilities", () => {
    const base = css.slice(css.indexOf("@layer base {"));
    expect(base).toMatch(
      /^@layer base \{\s*button:not\(:disabled\),\s*\[role="button"\]:not\(\[aria-disabled="true"\]\),\s*summary \{\s*cursor: pointer;\s*\}\s*\}/,
    );
  });
});

describe("the space between words in a mono label", () => {
  it("narrows to the script's own width in Tamil, Hindi and Korean, and leaves code alone", () => {
    expect(css).toMatch(
      /:where\(html:lang\(hi\), html:lang\(ko\), html:lang\(ta\)\) \.font-mono:not\(pre, pre \*, code, code \*\) \{\s*word-spacing: -0\.35em;\s*\}/,
    );
  });
});
