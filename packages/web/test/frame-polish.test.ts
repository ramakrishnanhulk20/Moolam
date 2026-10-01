import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { addresses, shortHex } from "@/lib/chain/client";
import en from "@/messages/en.json";

/**
 * The frame every page shares: which side of the menu says "you are here", how the
 * footer writes the registry, the colour of the browser's own bar, and the
 * guide's light finding the tab a phone can actually see.
 */

const here = { path: "/" };

vi.mock("@/lib/i18n/routing", () => ({
  Link: ({ href, children, ...rest }: Record<string, unknown> & { href: string; children?: unknown }) => {
    delete rest.prefetch;
    return createElement("a", { href, ...rest }, children as never);
  },
  usePathname: () => here.path,
}));

const { MenuBar } = await import("@/components/menu/MenuBar");
const { currentItem } = await import("@/components/menu/menu");
const { anchorOnScreen, everyFrame, spotFor } = await import("@/components/guide/GuideWalk");
const { THEME_BAR, themeBarColour } = await import("@/components/shell/ThemeColor");

/** The laptop bar on a route, closed or with one side open. */
function bar(path: string, open?: "personal" | "business"): string {
  here.path = path;
  return renderToStaticMarkup(
    createElement(
      NextIntlClientProvider,
      { locale: "en", timeZone: "UTC", messages: en },
      createElement(MenuBar, {
        home: null,
        tagline: "",
        right: null,
        initial: open === undefined ? undefined : { open, by: "press" as const },
      }),
    ),
  );
}

/** The side whose button holds the page being read, and the tiles drawn as the current page. */
function lit(path: string, open: "personal" | "business"): { side: string | null; tiles: string[] } {
  const html = bar(path, open);
  return {
    side: html.match(/data-menu-trigger="(\w+)" [^>]*data-holds-current="true"/)?.[1] ?? null,
    tiles: [...html.matchAll(/<a [^>]*>/g)]
      .map((found) => found[0])
      .filter((tag) => tag.includes('aria-current="page"'))
      .map((tag) => tag.match(/href="([^"]+)"/)?.[1] ?? ""),
  };
}

describe("the laptop menu marks the page being read", () => {
  // next-intl's usePathname hands back the route with the locale taken off, so
  // the address in the left column arrives as the path in the right one. A
  // passport lights Explore, as the phone bar's Explore tab does.
  it.each([
    ["/en/verify", "/verify", "personal", ["/verify"]],
    ["/en/explore/view?view=all", "/explore/view?view=all", "personal", ["/explore"]],
    ["/en/passport/0x1", "/passport/0x1", "personal", ["/explore"]],
    ["/en/docs/proof", "/docs/proof", "business", ["/docs/security/overview"]],
  ] as const)("%s lights %s / %j", (_address, path, side, expected) => {
    expect(lit(path, side)).toEqual({ side, tiles: expected });
  });

  it("gives the side that holds the page the accent and the short rule, and the other neither", () => {
    const html = bar("/verify");
    const button = (side: string) => {
      const at = html.indexOf(`data-menu-trigger="${side}"`);
      return html.slice(html.lastIndexOf("<button", at), html.indexOf("</button>", at));
    };
    expect(button("personal")).toContain("text-accent");
    expect(button("personal")).toMatch(/h-\[2px\] w-4 bg-accent/);
    expect(button("business")).toContain("text-text-muted");
    expect(button("business")).not.toContain("bg-accent");
  });

  it("keeps the names the guide lights", () => {
    const html = bar("/");
    expect(html).toContain('data-guide-anchor="verify"');
    expect(html).toContain('data-guide-anchor="studio"');
    expect(html).not.toContain('data-holds-current="true"');
    const layout = readFileSync("app/[locale]/layout.tsx", "utf8");
    expect(layout).toContain('data-guide-anchor="mine"');
    expect(layout).toContain("<MenuBar");
  });

  it("counts an agent's page and a challenge under the items they belong to", () => {
    expect(currentItem("/agent/10249")).toEqual({ side: "business", key: "agents" });
    expect(currentItem("/resolve/0xfeed")).toEqual({ side: "personal", key: "verify" });
    expect(currentItem("/docs/")).toEqual({ side: "personal", key: "how" });
    expect(currentItem("/verifying")).toBeNull();
  });
});

describe("the footer's registry line", () => {
  const layout = readFileSync("app/[locale]/layout.tsx", "utf8");
  const at = layout.indexOf("/address/${addresses.registry}");
  const link = layout.slice(at, layout.indexOf("</a>", at));

  it("shows a short lowercase id in a normal-case span", () => {
    const shown = shortHex(addresses.registry.toLowerCase());
    expect(shown).toBe(shown.toLowerCase());
    expect(shown).toMatch(/^0x[0-9a-f]{6}…[0-9a-f]{4}$/);
    expect(link).toContain('<span className="normal-case">{shortHex(addresses.registry.toLowerCase())}</span>');
  });

  it("keeps the full address in the title and the link's name, and keeps the link", () => {
    expect(link).toContain("title={addresses.registry}");
    expect(link).toContain('aria-label={`${f("registry")} ${addresses.registry}`}');
    expect(link).toContain('target="_blank"');
    expect(link).not.toContain("break-all");
  });

  it("gives every footer row the 44 px its tap pad takes, so no pad reaches the row above", () => {
    expect(layout).toContain('const FOOTER_ROW = "inline-flex min-h-11 items-center";');
    const foot = layout.slice(layout.indexOf("<footer"), layout.indexOf("</footer>"));
    const tappables = [...foot.matchAll(/<(a|Link|ShowGuideAgain)\b[^>]*?className=\{([^}]*)\}/gs)];
    expect(tappables).toHaveLength(6);
    for (const found of tappables) {
      expect(found[2]).toContain("FOOTER_ROW");
    }
    expect(foot).not.toMatch(/gap-y-3/);
  });
});

describe("the browser's own bar", () => {
  it("takes the page colour of the theme the reader chose", () => {
    const css = readFileSync("styles/globals.css", "utf8");
    expect(css).toContain(`--bg: ${THEME_BAR.dark};`);
    expect(css).toContain(`--bg: ${THEME_BAR.light};`);
    expect(themeBarColour("dark")).toBe(THEME_BAR.dark);
    expect(themeBarColour("light")).toBe(THEME_BAR.light);
    expect(themeBarColour(undefined)).toBeNull();
    expect(themeBarColour("system")).toBeNull();
  });

  it("is mounted once, in the layout", () => {
    const layout = readFileSync("app/[locale]/layout.tsx", "utf8");
    expect(layout.match(/<ThemeColor \/>/g)).toHaveLength(1);
  });
});

/** A stand-in for an element, with only what the guide reads. */
function fakeNode(name: string, rect: { left: number; top: number; width: number; height: number } | null, inert = false) {
  const box = rect ?? { left: 0, top: 0, width: 0, height: 0 };
  return {
    name,
    closest: (selector: string) => (selector === "[inert]" && inert ? {} : null),
    getBoundingClientRect: () => box,
    getClientRects: () => (rect === null ? [] : [box]),
  };
}

function fakeRoot(nodes: ReturnType<typeof fakeNode>[]) {
  return { querySelectorAll: () => nodes } as unknown as ParentNode;
}

describe("the guide's light on a phone", () => {
  // The header's copy of the anchor comes first in the page and is display
  // none below md; the bar's tab comes after it and is the one on the screen.
  const header = fakeNode("header link", null);
  const tab = fakeNode("bar tab", { left: 300, top: 756, width: 75, height: 56 });

  it("takes the visible element when a hidden one comes first", () => {
    expect((anchorOnScreen("mine", fakeRoot([header, tab])) as unknown as { name: string }).name).toBe("bar tab");
    expect(anchorOnScreen("mine", fakeRoot([header]))).toBeNull();
    expect(anchorOnScreen("mine", fakeRoot([fakeNode("asleep", { left: 300, top: 756, width: 75, height: 56 }, true)]))).toBeNull();
  });

  it("puts the light over the Mine tab at 375", () => {
    const spot = spotFor("mine", fakeRoot([header, tab]), { left: 0, top: 0, width: 375, height: 812 });
    expect(spot).toEqual({ x: 292, y: 748, width: 91, height: 72 });
  });

  it("measures with one loop, and nothing runs once it is stopped", () => {
    // Two chains with one cancel is what left step two's loop running behind
    // step three and put the light back on Make.
    let next = 0;
    const waiting = new Map<number, () => void>();
    const frames = {
      request: (run: () => void) => {
        next += 1;
        waiting.set(next, run);
        return next;
      },
      cancel: (id: number) => {
        waiting.delete(id);
      },
    };
    const flush = () => {
      const due = [...waiting.values()];
      waiting.clear();
      for (const run of due) run();
    };

    let looks = 0;
    const stop = everyFrame(() => {
      looks += 1;
    }, frames);
    expect(looks).toBe(1);
    expect(waiting.size).toBe(1);
    flush();
    flush();
    expect(looks).toBe(3);
    expect(waiting.size).toBe(1);

    stop();
    expect(waiting.size).toBe(0);
    flush();
    expect(looks).toBe(3);
  });
});
