import type { Tab } from "@/components/shell/tabs";

/**
 * The bench is English only: it never ships, and nothing here belongs in the
 * ten message files until Ram has picked a drawing.
 *
 * The five words are deliberately one word each. "Verify an image" and
 * "Register an image", which the top bar uses, are 15 and 17 characters and
 * cannot be read under a 22 px mark in a 75 px cell.
 */
export const TABS: Tab[] = [
  { key: "home", href: "/", label: "Home" },
  { key: "explore", href: "/explore", label: "Explore" },
  { key: "verify", href: "/verify", label: "Verify" },
  // The studio is the one route that carries the wallet. Left to prefetch, the
  // bar would pull half a megabyte of it behind every page on the site.
  { key: "make", href: "/studio", label: "Make", prefetch: false },
  { key: "mine", href: "/mine", label: "Mine" },
];

/** Drawing B lifts the middle one, so Make sits in the centre of the five. */
export const RAISED_TABS: Tab[] = [TABS[0], TABS[1], TABS[3], TABS[2], TABS[4]];

export type PageKey = "home" | "explore" | "verify" | "make" | "mine";

/** Which route each framed page is standing on, so the bar lights the right tab. */
export const PAGE_ROUTE: Record<PageKey, string> = {
  home: "/",
  explore: "/explore",
  verify: "/verify",
  make: "/studio",
  mine: "/mine",
};

export const PAGE_WORDS: Record<PageKey, string> = {
  home: "Home, the film",
  explore: "Explore",
  verify: "Verify",
  make: "Make, signed out",
  mine: "Mine, signed out",
};
