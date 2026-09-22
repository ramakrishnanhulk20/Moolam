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

/**
 * Whether the bar is drawn on this route at all.
 *
 * The benches are the one exception: they are a working surface, often drawing
 * the bar themselves, and a second one over the top would be measuring the
 * wrong thing.
 */
export function barShown(here: string): boolean {
  const path = tidy(here);
  return path !== "/lab" && !path.startsWith("/lab/");
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
