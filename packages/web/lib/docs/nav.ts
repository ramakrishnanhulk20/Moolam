import { readFileSync } from "node:fs";
import path from "node:path";
import { draftsVisible } from "./drafts";
import { docsRoot } from "./paths";
import { flatten, type NavEntry, type NavPage, type NavSection } from "./tree";

let cached: NavEntry[] | null = null;

/** Everything docs/nav.json names, drafts and all. Read once from disk. */
function wholeTree(): NavEntry[] {
  if (cached === null) {
    const raw = JSON.parse(readFileSync(path.join(docsRoot, "nav.json"), "utf8")) as { nav?: unknown };
    if (!Array.isArray(raw.nav)) {
      throw new Error("docs/nav.json needs a nav array");
    }
    cached = raw.nav as NavEntry[];
  }
  return cached;
}

/**
 * The order of the whole tree.
 *
 * A page marked draft is left out unless the caller asks for drafts or the lab
 * flag is on, and a section whose every page is a draft goes with them, so the
 * sidebar never shows an empty heading. The flag is read on each call rather
 * than held, because the deployed build and this machine's dev server run the
 * same code and have to answer differently.
 */
export function readNav(options: { drafts?: boolean } = {}): NavEntry[] {
  if (options.drafts === true || draftsVisible()) {
    return wholeTree();
  }

  const released: NavEntry[] = [];
  for (const entry of wholeTree()) {
    if (entry.type === "section") {
      const pages = entry.pages.filter((page) => page.draft !== true);
      if (pages.length > 0) {
        released.push({ ...entry, pages } satisfies NavSection);
      }
      continue;
    }
    if (entry.draft !== true) {
      released.push(entry);
    }
  }
  return released;
}

export function navPages(options: { drafts?: boolean } = {}): NavPage[] {
  return flatten(readNav(options));
}

/** Whether this slug is a page nobody outside this machine may reach yet. */
export function isDraft(slug: string): boolean {
  return navPages({ drafts: true }).some((page) => page.slug === slug && page.draft === true);
}

/** The section a page sits in, for the line above its title. Null for intro and faq. */
export function sectionOf(slug: string): string | null {
  for (const entry of readNav({ drafts: true })) {
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
