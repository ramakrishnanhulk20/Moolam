/**
 * The five places the phone bar can send someone, and which one it lights.
 *
 * The routes are the app's own, locale stripped, which is what next-intl's
 * usePathname hands back: "/", "/explore", "/passport/0x...". A page that is
 * not any tab's own, the docs above all, still gets the bar and lights nothing.
 */

export type TabKey = "home" | "explore" | "verify" | "make" | "mine";

export interface Tab {
  key: TabKey;
  href: string;
  /** The word under the icon, in the reader's language. The bar never holds copy of its own. */
  label: string;
  /** false for a route whose page carries the wallet, so the bar does not fetch it. */
  prefetch?: boolean;
  /**
   * The name the first-visit guide knows this place by. The walk measures the
   * element carrying it and cuts its spotlight over it, so the three steps
   * point at the real tabs rather than at a drawing of them.
   */
  anchor?: string;
}

/**
 * What each tab counts as its own.
 *
 * A passport and an agent are opened from the sheet, so they keep Explore lit
 * rather than dropping the reader onto a bar with nothing on it. Settling a
 * challenge is the verify side of the product, so it sits under Verify.
 */
const OWNED: Record<TabKey, readonly string[]> = {
  home: ["/"],
  explore: ["/explore", "/passport", "/agents", "/agent"],
  verify: ["/verify", "/resolve"],
  make: ["/studio"],
  mine: ["/mine"],
};

/** Drops a trailing slash so "/explore/" and "/explore" are one route. */
function tidy(here: string): string {
  const path = here.split("?")[0].split("#")[0];
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/** Whether a route belongs to a tab: the route itself, or anything under it. */
function owns(key: TabKey, path: string): boolean {
  return OWNED[key].some((root) => (root === "/" ? path === "/" : path === root || path.startsWith(`${root}/`)));
}

/**
 * Which tab a route lights, or null where none of them does.
 *
 * The docs are the case that matters: they keep the bar, because a reader who
 * opened a doc from the bar has to get back out of it, and they light nothing,
 * because the docs are not one of the five.
 */
export function activeTab(here: string): TabKey | null {
  const path = tidy(here);
  return (Object.keys(OWNED) as TabKey[]).find((key) => owns(key, path)) ?? null;
}

/** The bar's own height, without the safe area under it. The page reads it to keep clear. */
export const BAR_HEIGHT = 56;

/**
 * The room a page has to leave under its last line.
 *
 * env() is the phone's own home indicator, which is 34 px on the tall iPhones
 * and 0 on a laptop. --bar-safe lets a frame that is pretending to be a phone
 * ask for that strip on a machine that has none; nothing on the real site sets
 * it.
 */
export const BAR_ROOM = `calc(${BAR_HEIGHT}px + max(env(safe-area-inset-bottom), var(--bar-safe, 0px)))`;

/**
 * How far above the tab bar the menu's two sides sit: clear of the raised
 * Make disc, which stands 28 px above the bar, with 8 px of air.
 */
export const DOCK_GAP = 36;

/** The two sides' own bar: a 48 px button, 4 px of padding round it and a 1 px rule. */
export const DOCK_HEIGHT = 58;

/** The least a line of the page may sit above the two sides' bar. */
export const DOCK_AIR = 8;

/**
 * The phone's whole bottom room: the tab bar, the gap over the Make disc, the
 * two sides' bar, the air above it and the phone's home indicator strip. 158
 * px on a phone without one.
 *
 * This is the one measure for keeping clear of the bottom. The layout hands
 * it to every page as --bar-room, which the footer, the film's captions, the
 * framed film and the full-screen pages already read, so nothing sits under
 * either bar wherever it can come to rest.
 */
export const PHONE_ROOM = `calc(${BAR_HEIGHT + DOCK_GAP + DOCK_HEIGHT + DOCK_AIR}px + max(env(safe-area-inset-bottom), var(--bar-safe, 0px)))`;
