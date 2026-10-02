import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/i18n/routing", () => ({ usePathname: () => "/" }));

const { ThemeProvider, DEFAULT_THEME, THEME_STORAGE_KEY } = await import("@/components/providers/ThemeProvider");
const { THEME_BAR, ThemeColor, themeBarScript } = await import("@/components/shell/ThemeColor");

/** The body of every inline script in the markup, in document order. */
function scripts(markup: string): string[] {
  return [...markup.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((found) =>
    found[1].replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&"),
  );
}

/**
 * Just enough of a browser for the scripts that run before the first paint:
 * the html tag's classes, the two theme-color tags in the head, the storage and
 * the device's own dark setting.
 */
function browser({ stored, prefersDark }: { stored: string | null; prefersDark: boolean }) {
  const classes = new Set<string>(["font-vars"]);
  const bars = [
    { content: THEME_BAR.light, media: "(prefers-color-scheme: light)" },
    { content: THEME_BAR.dark, media: "(prefers-color-scheme: dark)" },
  ];
  const documentElement = {
    classList: {
      add: (...names: string[]) => names.forEach((name) => classes.add(name)),
      remove: (...names: string[]) => names.forEach((name) => classes.delete(name)),
      contains: (name: string) => classes.has(name),
    },
    style: {} as Record<string, string>,
    setAttribute: () => undefined,
  };
  const store = new Map<string, string>(stored === null ? [] : [[THEME_STORAGE_KEY, stored]]);
  const window = {
    matchMedia: (query: string) => ({ matches: query.includes("dark") ? prefersDark : !prefersDark }),
  };
  const context = {
    document: { documentElement, querySelectorAll: () => bars },
    localStorage: { getItem: (key: string) => store.get(key) ?? null },
    window,
  };
  return { context, classes, bars, documentElement };
}

/** What the server's HTML does before anything is painted, in the order it is written. */
function firstPaint(stored: string | null, prefersDark: boolean) {
  const page = browser({ stored, prefersDark });
  const markup = renderToStaticMarkup(
    createElement(ThemeProvider, null, createElement(ThemeColor)),
  );
  const found = scripts(markup);
  expect(found).toHaveLength(2);
  for (const body of found) {
    runInNewContext(body, page.context);
  }
  return page;
}

describe("the theme a visitor first sees", () => {
  it("is dark for a visitor with no stored choice on a device set to dark", () => {
    expect(DEFAULT_THEME).toBe("system");
    const page = firstPaint(null, true);
    expect(page.classes.has("dark")).toBe(true);
    expect(page.classes.has("light")).toBe(false);
    expect(page.documentElement.style.colorScheme).toBe("dark");
    // The class the page was rendered with survives next to the theme.
    expect(page.classes.has("font-vars")).toBe(true);
  });

  it("is light for a visitor with no stored choice on a device set to light", () => {
    const page = firstPaint(null, false);
    expect(page.classes.has("light")).toBe(true);
    expect(page.classes.has("dark")).toBe(false);
    expect(page.documentElement.style.colorScheme).toBe("light");
  });

  it("is dark for a visitor who chose dark, on a light device", () => {
    const page = firstPaint("dark", false);
    expect(page.classes.has("dark")).toBe(true);
    expect(page.classes.has("light")).toBe(false);
  });

  it("is light for a visitor who chose light, on a dark device", () => {
    const page = firstPaint("light", true);
    expect(page.classes.has("light")).toBe(true);
    expect(page.classes.has("dark")).toBe(false);
  });

  it("puts only light or dark on the page, never system, and the switch stores only those two", () => {
    for (const [stored, prefersDark] of [
      [null, true],
      [null, false],
      ["dark", false],
      ["light", true],
    ] as const) {
      const page = firstPaint(stored, prefersDark);
      expect(page.classes.has("system"), `${stored} ${prefersDark}`).toBe(false);
    }
    const provider = readFileSync("components/providers/ThemeProvider.tsx", "utf8");
    expect(provider).toContain("defaultTheme={DEFAULT_THEME}");
    expect(provider).toMatch(/\n\s+enableSystem\n/);
    expect(provider).not.toContain("enableSystem={false}");
    for (const file of ["components/ThemeToggle.tsx", "components/shell/PhoneHeader.tsx"]) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toContain('"system"');
      expect([...source.matchAll(/setTheme\("(\w+)"\)/g)].map((found) => found[1]).sort(), file).toEqual([
        "dark",
        "light",
      ]);
    }
  });

  it("is read from the resolved theme everywhere, so a reader never meets the word system", () => {
    for (const file of [
      "components/story/LandingStory.tsx",
      "components/docs/Mermaid.tsx",
      "components/providers/PrivyProvider.tsx",
      "components/shell/ThemeColor.tsx",
    ]) {
      const source = readFileSync(file, "utf8");
      expect(source, file).toMatch(/const \{ resolvedTheme \} = useTheme\(\);/);
      expect(source, file).not.toMatch(/const \{[^}]*\btheme\b[^}]*\} = useTheme\(\)/);
    }
  });
});

describe("the browser's own bar before the first paint", () => {
  it("is the dark ground for a first visit on a dark device, in both tags", () => {
    const page = firstPaint(null, true);
    expect(page.bars.map((bar) => bar.content)).toEqual([THEME_BAR.dark, THEME_BAR.dark]);
  });

  it("is the light ground for a first visit on a light device", () => {
    const page = firstPaint(null, false);
    expect(page.bars.map((bar) => bar.content)).toEqual([THEME_BAR.light, THEME_BAR.light]);
  });

  it("is the ground of the switch's choice whatever the device says", () => {
    expect(firstPaint("light", true).bars.map((bar) => bar.content)).toEqual([THEME_BAR.light, THEME_BAR.light]);
    expect(firstPaint("dark", false).bars.map((bar) => bar.content)).toEqual([THEME_BAR.dark, THEME_BAR.dark]);
  });

  it("runs after the theme script, which is what lets it read the class", () => {
    const markup = renderToStaticMarkup(createElement(ThemeProvider, null, createElement(ThemeColor)));
    const [theme, bar] = scripts(markup);
    expect(theme).toContain("localStorage");
    expect(bar).toBe(themeBarScript());
  });

  it("keeps both tags on the shown theme when a page change puts the head's own copy back", () => {
    const source = readFileSync("components/shell/ThemeColor.tsx", "utf8");
    expect(source).toContain("new MutationObserver(paint)");
    expect(source).toContain("watch.observe(document.head,");
    expect(source).toContain("return () => watch.disconnect();");
    // Setting a tag to the colour it already has is skipped, so the watch cannot feed itself.
    expect(source).toContain("if (tag.content !== colour)");
  });

  it("starts from one tag in the head for each device setting, for a page with no script", () => {
    const layout = readFileSync("app/[locale]/layout.tsx", "utf8");
    expect(layout).toContain(`{ media: "(prefers-color-scheme: light)", color: "${THEME_BAR.light}" }`);
    expect(layout).toContain(`{ media: "(prefers-color-scheme: dark)", color: "${THEME_BAR.dark}" }`);
  });
});

describe("a page with no script and no theme class", () => {
  const css = readFileSync("styles/globals.css", "utf8").replace(/\r\n/g, "\n");

  /** The custom properties inside the block that opens with `opener`, as one sorted list. */
  function tokens(opener: string): string[] {
    const at = css.indexOf(opener);
    expect(at, opener).toBeGreaterThan(-1);
    const body = css.slice(at + opener.length, css.indexOf("}", at));
    return body
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("--"))
      .sort();
  }

  it("takes the dark palette on a dark device, with the very values the dark class sets", () => {
    const named = tokens("\n.dark {\n");
    expect(named.length).toBeGreaterThan(15);
    expect(tokens("@media (prefers-color-scheme: dark) {\n  :root:not(.light) {\n")).toEqual(named);
  });

  it("lets a light class keep the device out of it, and the dark variant follow the class first", () => {
    expect(css).toContain("@media (prefers-color-scheme: dark) {\n  :root:not(.light) {");
    expect(css).toContain("&:where(:not(.light, .light *))");
    expect(css).toContain("&:where(.dark, .dark *)");
  });

  it("lets the browser's own scrollbars and controls follow the device until a class says otherwise", () => {
    expect(/\nhtml \{[^}]*color-scheme: light dark;/.exec(css)).not.toBeNull();
    expect(css).toContain("\n.dark {\n  color-scheme: dark;");
    expect(css).toContain("\n.light {\n  color-scheme: light;");
  });

  it("keeps the light tokens as the ones with no class, and the dark class after them", () => {
    const light = css.indexOf(":root,\n.light {\n");
    const dark = css.indexOf("\n.dark {\n  --bg: #08080a;");
    expect(css.slice(light, css.indexOf("\n}", light))).toContain("--bg: #e4ddd0;");
    // Both selectors weigh the same on <html>, so the dark block has to come
    // later to win when its class is there.
    expect(dark).toBeGreaterThan(light);
    expect(css).not.toMatch(/:root,\s*\.dark/);
  });
});

describe("the two pages no layout of ours wraps", () => {
  it("lets the page for a failure above every layout follow the device, with both palettes written out", () => {
    const source = readFileSync("app/global-error.tsx", "utf8");
    expect(source).toContain("@media (prefers-color-scheme: dark)");
    expect(source).toContain("color-scheme: light dark");
    expect(source).toContain(`--ground: ${THEME_BAR.light}`);
    expect(source).toContain(`--ground: ${THEME_BAR.dark}`);
    expect(source).not.toMatch(/(?:background|color): "#/);
  });

  it("draws the page for an address with no language from the stylesheet, which follows the device", () => {
    const source = readFileSync("app/not-found.tsx", "utf8");
    expect(source).toContain('import "@/styles/globals.css";');
    expect(source).toContain('className="min-h-dvh bg-bg text-text antialiased"');
    expect(source).not.toMatch(/<html[^>]*className=\{[^}]*(?:light|dark)/);
  });
});
