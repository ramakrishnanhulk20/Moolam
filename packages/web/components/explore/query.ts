import type { PassportConsent, PassportFilter, PassportPictures } from "@/lib/data/passports";

/**
 * The three chips that say which half of the registry is on the sheet: the real
 * pictures, the seed test cards the repository's scripts wrote, or both.
 */
export const PICTURE_VIEWS = ["pictures", "test", "all"] as const;

/** The chips that narrow the registry by what the record says. */
export const RECORD_VIEWS = ["generated", "captured", "edits", "rechecked", "manifest", "disputed"] as const;

/** Every chip over the grid, in the order they are drawn. */
export const EXPLORE_VIEWS = [...PICTURE_VIEWS, ...RECORD_VIEWS] as const;

export type ExploreView = (typeof EXPLORE_VIEWS)[number];

/**
 * The chips that narrow the sheet by what the holder said about AI use, in the
 * order they are drawn. "Any" is the way back and carries no value at all.
 */
export const AI_VIEWS = ["open", "closed", "ask", "none"] as const satisfies readonly PassportConsent[];

export type ExploreAi = (typeof AI_VIEWS)[number];

/** What the page opens on: the pictures, with the test cards one chip away. */
export const DEFAULT_VIEW: ExploreView = "pictures";

/** Everything the URL says about what the grid is showing. */
export interface ExploreSearch {
  view: ExploreView;
  /** The term typed into the search box, matched against the passport id. */
  search: string;
  /** An agent id, when a reader arrived from the agents page. */
  agent: string | null;
  /** What the holder must have said about AI use, or null for any answer at all. */
  ai: ExploreAi | null;
}

/**
 * What a bare /explore asks the index for, and the one view the build holds
 * before anybody opens the page. readExploreSearch answers with exactly this
 * for an address that names no chip, no term and no agent.
 */
export const DEFAULT_SEARCH: ExploreSearch = { view: DEFAULT_VIEW, search: "", agent: null, ai: null };

/**
 * The query keys this page reads.
 *
 * An address carrying any of them is asking for something other than the sheet
 * the build made, so it is drawn on the request. readExploreSearch and the rule
 * in proxy.ts both read this list, so a key can never narrow the page without
 * being sent to the route that can draw it.
 */
export const EXPLORE_KEYS = ["view", "q", "agent", "ai"] as const;

/** Whether an address asks for anything other than the view the build made. */
export function narrowsExplore(params: URLSearchParams): boolean {
  return EXPLORE_KEYS.some((key) => params.has(key));
}

function one(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? (value[0] ?? "") : (value ?? "")).trim();
}

/**
 * The chip a URL that names none is on.
 *
 * A bare /explore opens on the pictures. A link that already carries a search
 * term, an agent id or an AI-use answer opens on the whole registry instead:
 * someone who followed "see its passports" from an agent, shared a search for a
 * passport id, or was sent the set of pictures open to AI use is asking about
 * records rather than about which of them are test cards, and the pictures chip
 * would answer with a shorter grid than the link promised.
 */
export function impliedView(search: string, agent: string | null, ai: ExploreAi | null = null): ExploreView {
  return search !== "" || agent !== null || ai !== null ? "all" : DEFAULT_VIEW;
}

/**
 * The URL read back into what the page shows.
 *
 * Anything unknown falls back to the chip the URL implies rather than an error
 * page: a shared link with a chip this build no longer has should still open.
 */
export function readExploreSearch(params: Record<string, string | string[] | undefined>): ExploreSearch {
  const view = one(params.view).toLowerCase() as ExploreView;
  const digits = one(params.agent).replace(/[^0-9]/g, "");
  const agent = digits === "" ? null : digits;
  const search = one(params.q).slice(0, 80);
  const said = one(params.ai).toLowerCase() as ExploreAi;
  const ai = (AI_VIEWS as readonly string[]).includes(said) ? said : null;

  return {
    view: (EXPLORE_VIEWS as readonly string[]).includes(view) ? view : impliedView(search, agent, ai),
    search,
    agent,
    ai,
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

  const pictures = picturesFor(search.view);
  if (pictures !== undefined) {
    filter.pictures = pictures;
  }

  if (search.ai !== null) {
    filter.ai = search.ai;
  }
  if (search.search !== "") {
    filter.search = search.search;
  }
  if (search.agent !== null) {
    filter.generator = search.agent;
  }

  return filter;
}

/** Which half of the registry one chip asks for, or nothing when it asks for both. */
export function picturesFor(view: ExploreView): PassportPictures | undefined {
  if (view === "pictures") {
    return "real";
  }
  return view === "test" ? "test" : undefined;
}

/** Whether the grid under this chip can hold real pictures and test cards at once. */
export function isMixedView(view: ExploreView): boolean {
  return picturesFor(view) === undefined;
}

/**
 * The link behind one chip: the whole state of the page, so any view a reader
 * is looking at can be copied out of the address bar and sent to somebody else.
 *
 * The chip is left out of the link only when the rest of the link already
 * implies it, so every address reads back as the view it was copied from.
 *
 * No locale on the front. next-intl's Link puts that there.
 */
export function exploreHref(search: ExploreSearch): string {
  const params = new URLSearchParams();
  if (search.view !== impliedView(search.search, search.agent, search.ai)) {
    params.set("view", search.view);
  }
  if (search.search !== "") {
    params.set("q", search.search);
  }
  if (search.agent !== null) {
    params.set("agent", search.agent);
  }
  if (search.ai !== null) {
    params.set("ai", search.ai);
  }
  const query = params.toString();
  // A narrowed view points straight at the route that draws it on the request.
  // The bare page is built ahead of time, and a browser that has it cached
  // treats a change in the query string as no change at all: on 22 September a
  // press on a chip changed the address and drew nothing, because the router
  // reused the built page. A different path is a different page to it.
  return query === "" ? "/explore" : `/explore/view?${query}`;
}
