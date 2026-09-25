const LAB_PAGES = `NEXT_PUBLIC_${"LAB_PAGES"}`;

/**
 * The env read, with the name handed in rather than written at the point of
 * use.
 *
 * Next replaces every NEXT_PUBLIC_ name it can see with the value the build
 * ran with, and it folds what follows: written plainly, and even written as a
 * template string, this check compiled down to `return false` in the build of
 * 21 September 2026. Passing the name as an argument is the one shape the
 * replacement has nothing to match on, so the value is read when the request
 * is served. Either way the answer is the same on the machines that matter:
 * the flag is on here and off on the deployed site, at build and at runtime.
 */
function valueOf(name: string): string | undefined {
  return process.env[name];
}

/**
 * Whether this is Ram's own dev server, where NEXT_PUBLIC_LAB_PAGES is 1. Two
 * things hang on it: draft docs pages are shown, and his visits are not
 * counted. It is false everywhere else, including the deployed site, and false
 * in the browser, where process.env carries nothing this was not compiled with.
 */
export function labPagesOn(): boolean {
  return valueOf(LAB_PAGES) === "1";
}

/**
 * A page written but not released. It is reachable, listed, searchable and in
 * the sitemap only where labPagesOn() is true. Taking the flag out of
 * docs/nav.json is the whole release.
 */
export function draftsVisible(): boolean {
  return labPagesOn();
}

/**
 * The one rule readNav applies to a page: held back once it is marked draft,
 * unless the caller may see drafts. readNav keeps its own copy of this check
 * inline for both a page and a section's pages; this copy exists so the rule
 * stays under a test that marks its own page draft, for a day nav.json names
 * none. Defaults to the real flag so a check against one page reads the same
 * switch readNav does.
 */
export function isReleased(page: { draft?: boolean }, showDrafts: boolean = draftsVisible()): boolean {
  return showDrafts || page.draft !== true;
}
