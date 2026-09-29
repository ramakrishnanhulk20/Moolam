import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The mechanism, not the pixels.
 *
 * next/font emits its stylesheet wherever the face is imported, and all ten
 * languages share one Next route, so a script face imported anywhere the layout
 * can reach ships all five sheets to all ten languages: that is the regression
 * this file exists to catch. It reads source rather than rendering, because the
 * next/font call only resolves inside the bundler.
 */
const read = (relative: string) => readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), "utf8");

const SCRIPT_LOCALES = ["ta", "hi", "zh", "ja", "ko"] as const;

describe("the script faces", () => {
  it("each name a language the site actually serves", () => {
    // Read rather than imported: routing.ts reaches for next/navigation, which
    // only resolves inside the bundler.
    const locales = read("lib/i18n/routing.ts");
    for (const locale of SCRIPT_LOCALES) {
      expect(locales).toContain(`"${locale}"`);
    }
  });

  it("each ask for --font-script and never preload", () => {
    for (const locale of SCRIPT_LOCALES) {
      const source = read(`lib/fonts/script/${locale}.ts`);
      expect(source).toContain('variable: "--font-script"');
      expect(source).toContain("preload: false");
      expect(source).toContain('display: "swap"');
      expect(source.match(/from "next\/font\/google"/g)).toHaveLength(1);
    }
  });

  it("are loaded one at a time, by dynamic import, from ScriptFace", () => {
    const source = read("components/ScriptFace.tsx");
    for (const locale of SCRIPT_LOCALES) {
      expect(source).toContain(`${locale}: dynamic(() => import("@/lib/fonts/script/${locale}")`);
    }
    expect(source).not.toMatch(/^import .* from "@\/lib\/fonts\/script\//m);
  });

  it("stay out of the shared font module", () => {
    const source = read("lib/fonts.ts");
    expect(source).toContain('import { Archivo, IBM_Plex_Mono, Inter } from "next/font/google";');
    expect(source).not.toMatch(/Noto_Sans/);
  });

  it("stay out of the layout, which renders the component instead", () => {
    const source = read("app/[locale]/layout.tsx");
    expect(source).not.toMatch(/lib\/fonts\/script/);
    expect(source).not.toMatch(/Noto_Sans/);
    expect(source).toContain("<ScriptFace locale={locale} />");
  });
});

describe("the mono kickers", () => {
  it("lose most of their tracking in the scripts that have no capitals", () => {
    const css = read("styles/globals.css");
    const rule = String.raw`:where(html:lang(hi), html:lang(zh), html:lang(ja), html:lang(ko), html:lang(ta))
  :is(.tracking-\[0\.24em\], .tracking-\[0\.28em\]).font-mono.uppercase {
  letter-spacing: 0.08em;
}`;
    expect(css).toContain(rule);
  });
});
