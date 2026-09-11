import { navPages } from "./nav";
import { pageHref } from "./links";
import { readPage } from "./pages";
import { renderPage } from "./render";

export type SearchEntry = {
  slug: string;
  href: string;
  title: string;
  headings: { id: string; text: string }[];
  text: string;
};

/**
 * The whole corpus as one small file, built when the site is built.
 *
 * The headings come out of the rendered page rather than the markdown, so every
 * id in the index is the id the page really carries and a result lands on the
 * exact line it promised.
 */
export async function buildSearchIndex(): Promise<SearchEntry[]> {
  const entries: SearchEntry[] = [];
  for (const item of navPages()) {
    const page = readPage(item.slug);
    if (page === null) {
      continue;
    }
    const { heading, headings, text } = await renderPage(page.slug, page.body);
    entries.push({
      slug: page.slug,
      href: pageHref(page.slug),
      title: heading ?? page.title,
      headings: headings.map((one) => ({ id: one.id, text: one.text })),
      text,
    });
  }
  return entries;
}
