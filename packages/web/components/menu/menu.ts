import { activeTab, type TabKey } from "@/components/shell/tabs";

/**
 * The site's two-sided menu: what each side holds, which item the page being
 * read belongs to, and the one rule book the laptop bar and the phone sheet
 * both open and close by.
 *
 * Every word lives in the message files under `menu`, by the item's key, so
 * this file holds only the facts: where each item goes, how it is fetched,
 * which mark it carries and which routes count as its own.
 */

export const DREAMLOOM_URL = "https://dreamloom-production-3e74.up.railway.app";

export type Side = "personal" | "business";

export const SIDES: readonly Side[] = ["personal", "business"];

export type MarkName =
  | "verify"
  | "make"
  | "mine"
  | "explore"
  | "docs"
  | "business"
  | "kit"
  | "mcp"
  | "agents"
  | "pricing"
  | "live"
  | "shield";

export type ItemKey =
  | "verify"
  | "studio"
  | "mine"
  | "explore"
  | "how"
  | "business"
  | "kit"
  | "mcp"
  | "agents"
  | "pricing"
  | "dreamloom"
  | "security";

export interface MenuItem {
  key: ItemKey;
  href: string;
  mark: MarkName;
  /**
   * "intent" fetches the page once a pointer, focus or touch reaches for it.
   * Everything else is fetched only when pressed: a menu drawn on every page
   * must not pull every page it names, and two of them carry the wallet.
   */
  prefetch: "intent" | false;
  /**
   * The phone bar's tab this item is the same place as. Its page is marked by
   * the bar's own rule, activeTab, so the menu and the bar never disagree
   * about where a reader is.
   */
  tab?: TabKey;
  /**
   * The routes an item without a tab counts as its own: the route itself or
   * anything under it. The longest match wins, so the docs overview only
   * lights for a docs page no other item claims.
   */
  owns?: readonly string[];
}

export const MENU: Record<Side, readonly MenuItem[]> = {
  personal: [
    { key: "verify", href: "/verify", mark: "verify", prefetch: "intent", tab: "verify" },
    { key: "studio", href: "/studio", mark: "make", prefetch: false, tab: "make" },
    { key: "mine", href: "/mine", mark: "mine", prefetch: false, tab: "mine" },
    { key: "explore", href: "/explore", mark: "explore", prefetch: "intent", tab: "explore" },
    { key: "how", href: "/docs", mark: "docs", prefetch: false, owns: ["/docs"] },
  ],
  business: [
    { key: "business", href: "/business", mark: "business", prefetch: false, owns: ["/business"] },
    { key: "kit", href: "/docs/developers/platform-kit", mark: "kit", prefetch: false, owns: ["/docs/developers/platform-kit"] },
    { key: "mcp", href: "/docs/developers/mcp", mark: "mcp", prefetch: false, owns: ["/docs/developers/mcp"] },
    { key: "agents", href: "/agents", mark: "agents", prefetch: false, owns: ["/agents", "/agent"] },
    { key: "pricing", href: "/business#pricing", mark: "pricing", prefetch: false },
    { key: "dreamloom", href: DREAMLOOM_URL, mark: "live", prefetch: false },
    {
      key: "security",
      href: "/docs/security/overview",
      mark: "shield",
      prefetch: false,
      owns: ["/docs/security", "/docs/proof", "/docs/developers/prove-it"],
    },
  ],
};

/** The parts of a page the menu points at, such as the business page's pricing. */
export const HASHES: readonly string[] = SIDES.flatMap((side) =>
  MENU[side].flatMap((item) => (item.href.includes("#") ? [item.href.split("#")[1]] : [])),
);

/** True for an address that leaves the app, which opens in a new tab and skips the locale router. */
export function isExternal(href: string): boolean {
  return href.startsWith("https://");
}

/** Drops the query, the fragment and a trailing slash, so "/docs/" and "/docs?x" are "/docs". */
function tidy(here: string): string {
  const path = here.split("?")[0].split("#")[0];
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

export interface Current {
  side: Side;
  key: ItemKey;
}

/**
 * Which item the route belongs to, or null where none does.
 *
 * The route is next-intl's, with the locale already taken off. The items with
 * routes of their own are asked first, longest root winning, so the agents
 * board keeps /agents even though the phone bar files it under Explore. What
 * is left goes to the phone bar's own rule: a passport lights Explore in the
 * menu exactly as it lights the Explore tab, and the home page lights nothing.
 * Pricing points at a part of a page and Dreamloom off the site, so neither is
 * ever the page being read.
 */
export function currentItem(here: string): Current | null {
  const path = tidy(here);
  let best: (Current & { length: number }) | null = null;
  for (const side of SIDES) {
    for (const item of MENU[side]) {
      for (const root of item.owns ?? []) {
        const hit = path === root || path.startsWith(`${root}/`);
        if (hit && (best === null || root.length > best.length)) {
          best = { side, key: item.key, length: root.length };
        }
      }
    }
  }
  if (best !== null) {
    return { side: best.side, key: best.key };
  }
  const tab = activeTab(path);
  for (const side of SIDES) {
    const item = MENU[side].find((one) => one.tab !== undefined && one.tab === tab);
    if (item !== undefined) {
      return { side, key: item.key };
    }
  }
  return null;
}

/** How the open side was opened. Only a side opened by resting the pointer on it closes when the pointer leaves. */
export type OpenedBy = "press" | "hover" | "key";

export interface MenuState {
  open: Side | null;
  by: OpenedBy | null;
  /**
   * True once the pointer has carried an open menu across to this side. A
   * mouse reaches a trigger before it clicks it, so the click that follows is
   * the reader choosing this side, not asking to close it.
   */
  swapped?: boolean;
}

export const CLOSED: MenuState = { open: null, by: null };

export type MenuEvent =
  | { type: "press"; side: Side }
  | { type: "hover"; side: Side }
  | { type: "leave" }
  | { type: "key"; key: string; side?: Side }
  | { type: "outside" }
  | { type: "route" }
  | { type: "focusout" }
  | { type: "chosen" };

/**
 * The menu's one rule book, shared by the laptop bar and the phone sheet.
 *
 * A press on the open side closes it; a press on the other side swaps to it.
 * Resting the pointer opens a side, and moving to the other trigger while open
 * swaps without closing, and a press on the side the pointer swapped to keeps
 * it open. Escape, a press outside, focus leaving the menu, a
 * new route and a press on one of its links all close it. The last one
 * matters for Pricing and for the page already open, where the route does not
 * change and would otherwise leave the panel standing over the answer.
 */
export function menuReducer(state: MenuState, event: MenuEvent): MenuState {
  switch (event.type) {
    case "press":
      if (state.open === event.side && state.by !== "hover" && state.swapped !== true) {
        return CLOSED;
      }
      return { open: event.side, by: "press" };
    case "hover":
      if (state.open === event.side) {
        return state;
      }
      if (state.open === null) {
        return { open: event.side, by: "hover" };
      }
      return { open: event.side, by: state.by ?? "hover", swapped: true };
    case "leave":
      return state.by === "hover" ? CLOSED : state;
    case "key":
      if (event.key === "Escape") {
        return state.open === null ? state : CLOSED;
      }
      if ((event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") && event.side !== undefined) {
        return { open: event.side, by: "key" };
      }
      return state;
    case "outside":
    case "route":
    case "focusout":
    case "chosen":
      return state.open === null ? state : CLOSED;
  }
}
