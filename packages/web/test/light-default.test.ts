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
 * the html tag's classes, one theme-color tag in the head, the storage and the
 * device's own dark setting.
 */
function browser({ stored, prefersDark }: { stored: string | null; prefersDark: boolean }) {
  const classes = new Set<string>(["font-vars"]);
  const meta = { content: "#e4ddd0", media: "" };
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
    document: { documentElement, querySelectorAll: () => [meta] },
    localStorage: { getItem: (key: string) => store.get(key) ?? null },
    window,
  };
  return { context, classes, meta, documentElement };
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
  it("is light for a visitor with no stored choice on a device that prefers dark", () => {
    expect(DEFAULT_THEME).toBe("light");
    const page = firstPaint(null, true);
    expect(page.classes.has("light")).toBe(true);
    expect(page.classes.has("dark")).toBe(false);
    expect(page.documentElement.style.colorScheme).toBe("light");
    // The class the page was rendered with survives next to the theme.
    expect(page.classes.has("font-vars")).toBe(true);
  });

  it("is light on a device that prefers light too", () => {
    const page = firstPaint(null, false);
    expect(page.classes.has("light")).toBe(true);
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

  it("never reads the device setting, and the switch offers light and dark only", () => {
    const provider = readFileSync("components/providers/ThemeProvider.tsx", "utf8");
    expect(provider).toContain("enableSystem={false}");
    expect(provider).not.toMatch(/defaultTheme="system"/);
    for (const file of ["components/ThemeToggle.tsx", "components/shell/PhoneHeader.tsx"]) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toContain('"system"');
      expect([...source.matchAll(/setTheme\("(\w+)"\)/g)].map((found) => found[1]).sort(), file).toEqual([
        "dark",
        "light",
      ]);
    }
  });
});

describe("the browser's own bar before the first paint", () => {
  it("is the light ground for a first visit on a dark device", () => {
    const page = firstPaint(null, true);
    expect(page.meta.content).toBe(THEME_BAR.light);
  });

  it("is the dark ground for a visitor who chose dark", () => {
    const page = firstPaint("dark", false);
    expect(page.meta.content).toBe(THEME_BAR.dark);
  });

  it("runs after the theme script, which is what lets it read the class", () => {
    const markup = renderToStaticMarkup(createElement(ThemeProvider, null, createElement(ThemeColor)));
    const [theme, bar] = scripts(markup);
    expect(theme).toContain("localStorage");
    expect(bar).toBe(themeBarScript());
  });

  it("starts from one light tag in the head, with no device query", () => {
    const layout = readFileSync("app/[locale]/layout.tsx", "utf8");
    expect(layout).toContain(`themeColor: "${THEME_BAR.light}"`);
    expect(layout).not.toContain("prefers-color-scheme");
  });
});
