import { readFileSync } from "node:fs";
import path from "node:path";
import { docsRoot } from "./paths";
import { flatten, type NavEntry, type NavPage } from "./tree";

let cached: NavEntry[] | null = null;

/** The order of the whole tree, read once from docs/nav.json. */
export function readNav(): NavEntry[] {
  if (cached === null) {
    const raw = JSON.parse(readFileSync(path.join(docsRoot, "nav.json"), "utf8")) as { nav?: unknown };
    if (!Array.isArray(raw.nav)) {
      throw new Error("docs/nav.json needs a nav array");
    }
    cached = raw.nav as NavEntry[];
  }
  return cached;
}

export function navPages(): NavPage[] {
  return flatten(readNav());
}

/** The section a page sits in, for the line above its title. Null for intro and faq. */
export function sectionOf(slug: string): string | null {
  for (const entry of readNav()) {
    if (entry.type === "section" && entry.pages.some((page) => page.slug === slug)) {
      return entry.title;
    }
  }
  return null;
}

export function neighbours(slug: string): { previous: NavPage | null; next: NavPage | null } {
  const pages = navPages();
  const at = pages.findIndex((page) => page.slug === slug);
  if (at === -1) {
    return { previous: null, next: null };
  }
  return { previous: pages[at - 1] ?? null, next: pages[at + 1] ?? null };
}
