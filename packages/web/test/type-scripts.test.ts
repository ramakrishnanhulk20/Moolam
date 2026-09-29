import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import { TAMIL_HEADING_LEADING, useHeadingLeading } from "@/components/studio/leading";

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
    expect(tamers.length).toBe(2);
    for (const rule of tamers) expect(rule).toContain("html:lang(ta)");
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
