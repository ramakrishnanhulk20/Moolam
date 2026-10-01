// @vitest-environment jsdom
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { act, createElement, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pageExists } from "@/lib/docs/pages";
import { indexSlug } from "@/lib/docs/links";
import { activeTab } from "@/components/shell/tabs";
import en from "@/messages/en.json";

/**
 * The two-sided menu on the real site: every item goes to a real page; every
 * word is in all ten message files; it opens on a press, swaps sides, and
 * closes on Escape, a press outside, a new route and a press on one of its own
 * links; the keyboard reaches every tile; and the page being read is marked on
 * its side's button and its tile, by the phone bar's own rule.
 */

const here = { path: "/" };

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: Record<string, unknown> & { href: string; children?: ReactNode }) => {
    const { href, children, prefetch, ...rest } = props;
    return createElement(
      "a",
      { href, "data-prefetch": prefetch === null ? "default" : String(prefetch), ...rest },
      children,
    );
  },
  usePathname: () => here.path,
}));

const { MENU, SIDES, CLOSED, DREAMLOOM_URL, HASHES, currentItem, menuReducer, isExternal } = await import(
  "@/components/menu/menu"
);
const { stepLink } = await import("@/components/menu/useMenu");
const { MenuBar } = await import("@/components/menu/MenuBar");
const { PhoneMenu } = await import("@/components/menu/PhoneMenu");
const { BAR_ROOM, DOCK_GAP, PHONE_ROOM } = await import("@/components/shell/tabs");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
})) as unknown as typeof window.matchMedia;

// jsdom replaces URL, so the package root is the working directory the suite runs from.
const WEB = process.cwd();
const APP = path.join(WEB, "app", "[locale]");
const LANGS = ["en", "de", "es", "fr", "hi", "ja", "ko", "pt", "ta", "zh"] as const;
const LONG_DASH = String.fromCharCode(0x2014);

const every = SIDES.flatMap((side) => MENU[side].map((item) => ({ side, item })));

function withWords(node: ReactElement): ReactElement {
  return createElement(NextIntlClientProvider, { locale: "en", timeZone: "UTC", messages: en }, node);
}

/** Whether an app route answers: a page file in the route's own folder. */
function appRouteExists(route: string): boolean {
  const parts = route.split("/").filter(Boolean);
  return existsSync(path.join(APP, ...parts, "page.tsx"));
}

function linksIn(html: string) {
  return [...html.matchAll(/<a [^>]*data-menu-link="([^"]+)"[^>]*>/g)].map((match) => ({
    key: match[1],
    current: match[0].includes('aria-current="page"'),
  }));
}

describe("every item goes somewhere real", () => {
  it.each(every.map(({ item }) => [item.key, item.href]))("%s (%s)", (_key, href) => {
    if (isExternal(href)) {
      expect(href).toBe(DREAMLOOM_URL);
      return;
    }
    const [route] = href.split("#");
    if (route === "/docs" || route.startsWith("/docs/")) {
      const slug = route === "/docs" ? indexSlug : route.slice("/docs/".length);
      expect(pageExists(slug), `docs page ${slug}`).toBe(true);
      return;
    }
    expect(appRouteExists(route), `app route ${route}`).toBe(true);
  });

  it("lists the business page first on the business side, and sends Pricing to its section", () => {
    expect(MENU.personal.map((item) => item.key)).toEqual(["verify", "studio", "mine", "explore", "how"]);
    expect(MENU.business.map((item) => item.key)).toEqual([
      "business",
      "kit",
      "mcp",
      "agents",
      "pricing",
      "dreamloom",
      "security",
    ]);
    expect(MENU.business[0].href).toBe("/business");
    expect(MENU.business.find((item) => item.key === "pricing")?.href).toBe("/business#pricing");
    const page = readFileSync(path.join(WEB, "components", "business", "Sections.tsx"), "utf8");
    expect(page).toContain('id="pricing"');
  });

  it("gives no two items the same address, and fetches only Verify and Explore before a press", () => {
    const hrefs = every.map(({ item }) => item.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(every.filter(({ item }) => item.prefetch === "intent").map(({ item }) => item.key)).toEqual([
      "verify",
      "explore",
    ]);
  });
});

describe("every word is in the message files", () => {
  const files = Object.fromEntries(
    LANGS.map((lang) => [lang, JSON.parse(readFileSync(path.join(WEB, "messages", `${lang}.json`), "utf8"))]),
  ) as Record<string, { menu: Record<string, unknown> & { items: Record<string, { name: string; line: string }> } }>;

  it("names and describes every item in one line, in English", () => {
    for (const { item } of every) {
      const words = files.en.menu.items[item.key];
      expect(words.name.length, item.key).toBeGreaterThan(0);
      expect(words.line.length, item.key).toBeGreaterThan(0);
      expect(words.line).not.toMatch(/\n/);
    }
    expect(Object.keys(files.en.menu.items).sort()).toEqual(every.map(({ item }) => item.key).sort());
  });

  it("carries the same menu block in all ten files until the translators reach it", () => {
    for (const lang of LANGS) {
      expect(files[lang].menu, lang).toEqual(files.en.menu);
    }
  });

  it("writes no word of its own in the menu's files", () => {
    for (const name of ["MenuBar.tsx", "MenuPanel.tsx", "PhoneMenu.tsx", "Tiles.tsx"]) {
      const source = readFileSync(path.join(WEB, "components", "menu", name), "utf8");
      for (const phrase of ["For personal", "For business", "You are here", "Arrows move", "Esc closes", "Close the menu"]) {
        expect(source, `${name}: ${phrase}`).not.toContain(`"${phrase}"`);
        expect(source, `${name}: ${phrase}`).not.toMatch(new RegExp(`>\\s*${phrase}\\s*<`));
      }
    }
  });
});

describe("the rule book", () => {
  const open = (side: "personal" | "business", by: "press" | "hover" | "key") => ({ open: side, by });

  it("opens on a press, swaps on the other side's press, closes on the same press", () => {
    let state = menuReducer(CLOSED, { type: "press", side: "personal" });
    expect(state).toEqual(open("personal", "press"));
    state = menuReducer(state, { type: "press", side: "business" });
    expect(state).toEqual(open("business", "press"));
    expect(menuReducer(state, { type: "press", side: "business" })).toEqual(CLOSED);
  });

  it("closes on Escape, a press outside, focus leaving, a new route and a press on one of its links", () => {
    for (const type of ["outside", "focusout", "route", "chosen"] as const) {
      expect(menuReducer(open("personal", "press"), { type })).toEqual(CLOSED);
      expect(menuReducer(open("business", "key"), { type })).toEqual(CLOSED);
      expect(menuReducer(CLOSED, { type })).toBe(CLOSED);
    }
    expect(menuReducer(open("business", "key"), { type: "key", key: "Escape" })).toEqual(CLOSED);
  });

  it("keeps a side open when the click lands on the trigger the pointer just swapped to", () => {
    // A mouse crosses the other trigger before it clicks it: the swap comes
    // first, and the click must choose that side rather than shut it.
    let state = menuReducer(CLOSED, { type: "press", side: "personal" });
    state = menuReducer(state, { type: "hover", side: "business" });
    expect(state.open).toBe("business");
    state = menuReducer(state, { type: "press", side: "business" });
    expect(state).toEqual(open("business", "press"));
    expect(menuReducer(state, { type: "press", side: "business" })).toEqual(CLOSED);
  });

  it("knows the one fragment it links to, so it can land there after the page arrives", () => {
    expect(HASHES).toEqual(["pricing"]);
  });

  it("closes on the pointer leaving only what the pointer opened", () => {
    const hovered = menuReducer(CLOSED, { type: "hover", side: "personal" });
    expect(menuReducer(hovered, { type: "leave" })).toEqual(CLOSED);
    expect(menuReducer(open("personal", "press"), { type: "leave" })).toEqual(open("personal", "press"));
  });

  it("moves focus with the arrows and wraps at both ends", () => {
    expect(stepLink(-1, "ArrowDown", 5)).toBe(0);
    expect(stepLink(4, "ArrowDown", 5)).toBe(0);
    expect(stepLink(0, "ArrowUp", 5)).toBe(4);
    expect(stepLink(2, "End", 5)).toBe(4);
    expect(stepLink(2, "Tab", 5)).toBeNull();
  });
});

describe("the page being read is marked", () => {
  it.each([
    ["/verify", "personal", "verify"],
    ["/resolve/0xfeed", "personal", "verify"],
    ["/studio", "personal", "studio"],
    ["/mine", "personal", "mine"],
    ["/explore/view", "personal", "explore"],
    ["/passport/0xabc", "personal", "explore"],
    ["/docs", "personal", "how"],
    ["/docs/guides/explore", "personal", "how"],
    ["/business", "business", "business"],
    ["/docs/developers/platform-kit", "business", "kit"],
    ["/docs/developers/mcp/", "business", "mcp"],
    ["/agents", "business", "agents"],
    ["/agent/12", "business", "agents"],
    ["/docs/security/threat-model", "business", "security"],
    ["/docs/proof", "business", "security"],
  ])("%s lights %s / %s", (route, side, key) => {
    expect(currentItem(route)).toEqual({ side, key });
  });

  it("agrees with the phone bar on every page the two share", () => {
    for (const route of ["/verify", "/resolve/0x1", "/studio", "/mine", "/explore", "/passport/0x1"]) {
      const item = every.find(({ item: one }) => one.key === currentItem(route)?.key)?.item;
      expect(item?.tab, route).toBe(activeTab(route));
    }
  });

  it("lights nothing on the home page or a route neither side holds", () => {
    expect(currentItem("/")).toBeNull();
    expect(currentItem("/connect")).toBeNull();
    expect(currentItem("/verifyx")).toBeNull();
  });

  it("marks the side's button and its tile on the laptop bar, and nothing else", () => {
    here.path = "/verify";
    const html = renderToStaticMarkup(
      withWords(createElement(MenuBar, { home: null, tagline: "", right: null, initial: { open: "personal", by: "press" } })),
    );
    const links = linksIn(html);
    expect(links.map((link) => link.key)).toEqual(MENU.personal.map((item) => item.key));
    expect(links.filter((link) => link.current).map((link) => link.key)).toEqual(["verify"]);
    expect(html).toMatch(/data-menu-trigger="personal"[^>]*data-holds-current="true"/);
    expect(html).not.toMatch(/data-menu-trigger="business"[^>]*data-holds-current/);
    expect(html).toContain("You are here");
  });

  it("draws the bar closed with both sides and no tiles until one is opened", () => {
    here.path = "/";
    const html = renderToStaticMarkup(withWords(createElement(MenuBar, { home: null, tagline: "", right: null })));
    expect(linksIn(html)).toEqual([]);
    expect(html).toContain("For personal");
    expect(html).toContain("For business");
    expect(html).toMatch(/aria-expanded="false"[^>]*data-menu-trigger="personal"/);
  });

  it("marks the business page in the phone sheet, with the two sides as its tabs", () => {
    here.path = "/business";
    const html = renderToStaticMarkup(withWords(createElement(PhoneMenu, { initial: { open: "business", by: "press" } })));
    const links = linksIn(html);
    expect(links.map((link) => link.key)).toEqual(MENU.business.map((item) => item.key));
    expect(links.filter((link) => link.current).map((link) => link.key)).toEqual(["business"]);
    expect(html).toMatch(/role="tab" aria-selected="true"[^>]*data-sheet-side="business"/);
    expect(html).toMatch(/role="tab" aria-selected="false"[^>]*data-sheet-side="personal"/);
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain(`href="${DREAMLOOM_URL}" target="_blank" rel="noreferrer"`);
  });

  it("draws no room of its own: the page keeps clear by the one measure", () => {
    here.path = "/";
    const html = renderToStaticMarkup(withWords(createElement(PhoneMenu, {})));
    expect(html).not.toMatch(/style="height:\d+px"/);
  });
});

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.replaceChildren();
  here.path = "/";
});

async function mount(node: ReactElement): Promise<HTMLDivElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(withWords(node)));
  return host;
}

async function press(node: Element) {
  await act(async () => (node as HTMLElement).click());
}

async function key(name: string, target: EventTarget = document) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
  });
}

describe("the laptop bar in a browser", () => {
  const trigger = (host: HTMLElement, side: string) =>
    host.querySelector<HTMLButtonElement>(`[data-menu-trigger="${side}"]`) as HTMLButtonElement;

  it("opens on a press, swaps sides, and closes on Escape with the focus back on the side", async () => {
    const host = await mount(createElement(MenuBar, { home: null, tagline: "", right: null }));
    await press(trigger(host, "personal"));
    expect(trigger(host, "personal").getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector('[data-menu-side="personal"] [data-menu-link="verify"]')).not.toBeNull();

    await press(trigger(host, "business"));
    expect(trigger(host, "personal").getAttribute("aria-expanded")).toBe("false");
    expect(trigger(host, "business").getAttribute("aria-expanded")).toBe("true");

    trigger(host, "business").focus();
    await key("Escape");
    expect(trigger(host, "business").getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger(host, "business"));
  });

  it("closes on a press outside it", async () => {
    const host = await mount(createElement(MenuBar, { home: null, tagline: "", right: null }));
    await press(trigger(host, "personal"));
    await act(async () => {
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(trigger(host, "personal").getAttribute("aria-expanded")).toBe("false");
  });

  it("closes on a press on one of its own tiles, where the route may not change", async () => {
    here.path = "/business";
    const host = await mount(createElement(MenuBar, { home: null, tagline: "", right: null }));
    await press(trigger(host, "business"));
    const pricing = host.querySelector('[data-menu-side="business"] [data-menu-link="pricing"]') as HTMLAnchorElement;
    expect(pricing.getAttribute("href")).toBe("/business#pricing");
    await act(async () => {
      pricing.addEventListener("click", (event) => event.preventDefault(), { once: true });
      pricing.click();
    });
    expect(trigger(host, "business").getAttribute("aria-expanded")).toBe("false");
  });

  it("opens with Arrow down from the keyboard, lands on the first tile and moves with the arrows", async () => {
    const host = await mount(createElement(MenuBar, { home: null, tagline: "", right: null }));
    trigger(host, "personal").focus();
    await key("ArrowDown", trigger(host, "personal"));
    expect(trigger(host, "personal").getAttribute("aria-expanded")).toBe("true");
    expect((document.activeElement as HTMLElement).getAttribute("data-menu-link")).toBe("verify");
    await key("ArrowDown", document.activeElement as HTMLElement);
    expect((document.activeElement as HTMLElement).getAttribute("data-menu-link")).toBe("studio");
    await key("End", document.activeElement as HTMLElement);
    expect((document.activeElement as HTMLElement).getAttribute("data-menu-link")).toBe("how");
  });

  it("fetches Verify on intent and the wallet pages never", async () => {
    const host = await mount(createElement(MenuBar, { home: null, tagline: "", right: null }));
    await press(trigger(host, "personal"));
    const prefetch = (name: string) =>
      host.querySelector(`[data-menu-side="personal"] [data-menu-link="${name}"]`)?.getAttribute("data-prefetch");
    expect(prefetch("verify")).toBe("false");
    expect(prefetch("studio")).toBe("false");
    expect(prefetch("mine")).toBe("false");
    await act(async () => {
      (host.querySelector('[data-menu-link="verify"]') as HTMLElement).focus();
    });
    expect(prefetch("verify")).toBe("default");
  });
});

describe("the phone menu in a browser", () => {
  const dock = (host: HTMLElement, side: string) =>
    host.querySelector<HTMLButtonElement>(`button[data-sheet-side="${side}"]:not([role="tab"])`) as HTMLButtonElement;
  const tab = (host: HTMLElement, side: string) =>
    host.querySelector<HTMLButtonElement>(`[role="tab"][data-sheet-side="${side}"]`);

  it("rises from the pressed side, swaps by its tabs and closes on Escape", async () => {
    const host = await mount(createElement(PhoneMenu, {}));
    expect(tab(host, "personal")).toBeNull();
    await press(dock(host, "business"));
    expect(dock(host, "business").getAttribute("aria-expanded")).toBe("true");
    expect(tab(host, "business")?.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab(host, "business"));

    await press(tab(host, "personal") as HTMLButtonElement);
    expect(tab(host, "personal")?.getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector('[data-menu-side="personal"] [data-menu-link="verify"]')).not.toBeNull();

    await key("Escape");
    expect(dock(host, "personal").getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(dock(host, "personal"));
  });

  it("closes from its own close button and from a press on a tile", async () => {
    const host = await mount(createElement(PhoneMenu, {}));
    await press(dock(host, "personal"));
    await press(host.querySelector('button[aria-label="Close the menu"]') as HTMLButtonElement);
    expect(dock(host, "personal").getAttribute("aria-expanded")).toBe("false");

    await press(dock(host, "personal"));
    const verify = host.querySelector('[data-menu-side="personal"] [data-menu-link="verify"]') as HTMLAnchorElement;
    await act(async () => {
      verify.addEventListener("click", (event) => event.preventDefault(), { once: true });
      verify.click();
    });
    expect(dock(host, "personal").getAttribute("aria-expanded")).toBe("false");
  });

  it("marks the side holding the page being read on the two sides' bar", async () => {
    here.path = "/docs/developers/mcp";
    const host = await mount(createElement(PhoneMenu, {}));
    expect(dock(host, "business").getAttribute("data-holds-current")).toBe("true");
    expect(dock(host, "personal").hasAttribute("data-holds-current")).toBe(false);
  });
});

describe("the layout", () => {
  const layout = readFileSync(path.join(APP, "layout.tsx"), "utf8");

  it("draws the menu bar inside the laptop header, and no list of links of its own", () => {
    const header = layout.slice(layout.indexOf('<header className="app-header sticky'), layout.indexOf("</header>"));
    expect(header).toContain("<MenuBar");
    expect(layout).not.toContain("const nav = [");
    expect(layout).not.toContain("HeaderNav");
    expect(existsSync(path.join(WEB, "components", "shell", "HeaderNav.tsx"))).toBe(false);
  });

  it("draws the phone menu beside the tab bar, below md only", () => {
    const at = layout.indexOf("<PhoneMenu />");
    expect(at).toBeGreaterThan(layout.indexOf("<BottomBar"));
    const box = layout.lastIndexOf('<div className="md:hidden">', at);
    expect(box).toBeGreaterThan(-1);
    expect(layout.slice(box, at)).toContain("<BottomBar");
    expect(layout.slice(box, at)).not.toContain("</div>");
  });
});

describe("the phone's one bottom room", () => {
  const safe = "max(env(safe-area-inset-bottom), var(--bar-safe, 0px))";

  it("is the tab bar, the gap over the Make disc, the two sides' bar and 8 px of air, plus the home strip", () => {
    expect(PHONE_ROOM).toBe(`calc(158px + ${safe})`);
    expect(BAR_ROOM).toBe(`calc(56px + ${safe})`);
    const menu = readFileSync(path.join(WEB, "components", "menu", "PhoneMenu.tsx"), "utf8");
    expect(menu).toContain("const DOCK_BOTTOM = `calc(${BAR_ROOM} + ${DOCK_GAP}px)`;");
    expect(DOCK_GAP).toBe(36);
  });

  it("reaches every page as --bar-room, from the column that holds the header, main, footer and bars", () => {
    const layout = readFileSync(path.join(APP, "layout.tsx"), "utf8");
    expect(layout).toContain('<div className="flex min-h-dvh flex-col" style={{ "--bar-room": PHONE_ROOM } as CSSProperties}>');
    const column = layout.indexOf('style={{ "--bar-room": PHONE_ROOM }');
    for (const part of ["<PhoneHeader", "<main", "<footer", "<BottomBar", "<PhoneMenu"]) {
      expect(layout.indexOf(part), part).toBeGreaterThan(column);
    }
  });

  it("is read only by phone rules, so a laptop is untouched", () => {
    // Every page that pads itself by the room drops the padding from md up.
    const readers: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name !== "lab") walk(full);
        } else if (/\.tsx?$/.test(name)) {
          for (const line of readFileSync(full, "utf8").split("\n")) {
            if (line.includes("pb-[var(--bar-room)]")) readers.push(`${name}: ${line.trim()}`);
          }
        }
      }
    };
    walk(path.join(WEB, "app"));
    walk(path.join(WEB, "components"));
    expect(readers.length).toBeGreaterThanOrEqual(3);
    for (const line of readers) {
      expect(line).toContain("md:pb-0");
    }
    // The film's captions and the framed film read it inside phone-only rules.
    const css = readFileSync(path.join(WEB, "styles", "globals.css"), "utf8").replace(/\r/g, "");
    for (const rule of ["--film-words-foot: var(--bar-room);", "--frame-foot: var(--bar-room);"]) {
      const at = css.indexOf(rule);
      expect(at, rule).toBeGreaterThan(-1);
      // The nearest media rule opened before it is the phone one, and no top-level block closed in between.
      expect(css.lastIndexOf("@media (max-width: 767px)", at)).toBeGreaterThan(css.lastIndexOf("\n}\n", at));
    }
  });
});

describe("house rules", () => {
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() ? files(full) : [full];
    });
  }

  it("carries no long dash in any menu file or this test", () => {
    const all = [...files(path.join(WEB, "components", "menu")), path.join(WEB, "test", "menu-rollin.test.ts")];
    expect(all.length).toBeGreaterThan(5);
    for (const file of all) {
      expect(readFileSync(file, "utf8").includes(LONG_DASH), file).toBe(false);
    }
  });
});
