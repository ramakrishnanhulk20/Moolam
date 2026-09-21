export type NavPage = {
  slug: string;
  title: string;
  /** A shorter name for the tree where the page title is too long for it. */
  label?: string;
  /**
   * Written, not released. A draft page is reachable, listed, searchable and in
   * the sitemap only where the lab flag is on. Taking this line out of
   * docs/nav.json is the whole release.
   */
  draft?: boolean;
};

export type NavSection = {
  type: "section";
  title: string;
  open?: boolean;
  pages: NavPage[];
};

export type NavEntry = ({ type: "page" } & NavPage) | NavSection;

export type Heading = { id: string; text: string; depth: 2 | 3 };

export function navLabel(page: NavPage): string {
  return page.label ?? page.title;
}

/** Every page in reading order, which is also the order previous and next walk. */
export function flatten(nav: NavEntry[]): NavPage[] {
  return nav.flatMap((entry) =>
    entry.type === "section"
      ? entry.pages
      : [{ slug: entry.slug, title: entry.title, label: entry.label, draft: entry.draft }],
  );
}
