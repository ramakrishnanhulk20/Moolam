import type { PassportFilter } from "@/lib/data/passports";

/** The seven chips over the grid, in the order they are drawn. */
export const EXPLORE_VIEWS = [
  "all",
  "generated",
  "captured",
  "edits",
  "rechecked",
  "manifest",
  "disputed",
] as const;

export type ExploreView = (typeof EXPLORE_VIEWS)[number];

/** Everything the URL says about what the grid is showing. */
export interface ExploreSearch {
  view: ExploreView;
  /** The term typed into the search box, matched against the passport id. */
  search: string;
  /** An agent id, when a reader arrived from the agents page. */
  agent: string | null;
}

function one(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? (value[0] ?? "") : (value ?? "")).trim();
}

/**
 * The URL read back into what the page shows.
 *
 * Anything unknown falls back to the whole registry rather than an error page:
 * a shared link with a chip this build no longer has should still open.
 */
export function readExploreSearch(params: Record<string, string | string[] | undefined>): ExploreSearch {
  const view = one(params.view).toLowerCase() as ExploreView;
  const agent = one(params.agent).replace(/[^0-9]/g, "");

  return {
    view: (EXPLORE_VIEWS as readonly string[]).includes(view) ? view : "all",
    search: one(params.q).slice(0, 80),
    agent: agent === "" ? null : agent,
  };
}

/** What the index is asked for, given what the URL says. */
export function filterFor(search: ExploreSearch): PassportFilter {
  const filter: PassportFilter = {};

  if (search.view === "generated") {
    filter.kind = 0;
  } else if (search.view === "captured") {
    filter.kind = 1;
  } else if (search.view === "edits") {
    filter.kind = 2;
  } else if (search.view === "rechecked") {
    filter.rechecked = true;
  } else if (search.view === "manifest") {
    filter.manifest = true;
  } else if (search.view === "disputed") {
    filter.disputed = true;
  }

  if (search.search !== "") {
    filter.search = search.search;
  }
  if (search.agent !== null) {
    filter.generator = search.agent;
  }

  return filter;
}

/**
 * The link behind one chip: the whole state of the page, so any view a reader
 * is looking at can be copied out of the address bar and sent to somebody else.
 *
 * No locale on the front. next-intl's Link puts that there.
 */
export function exploreHref(search: ExploreSearch): string {
  const params = new URLSearchParams();
  if (search.view !== "all") {
    params.set("view", search.view);
  }
  if (search.search !== "") {
    params.set("q", search.search);
  }
  if (search.agent !== null) {
    params.set("agent", search.agent);
  }
  const query = params.toString();
  return query === "" ? "/explore" : `/explore?${query}`;
}
