import type { Metadata } from "next";
import { connection } from "next/server";
import { getTranslations } from "next-intl/server";
import { reason } from "@/lib/chain/client";
import { heldRegistryCounts, type PassportCursor, type RegistryCounts } from "@/lib/data/passports";
import { Filters } from "./Filters";
import { Grid } from "./Grid";
import { Masthead } from "./Masthead";
import { NoMatch } from "./NoMatch";
import { heldPictureSplit, sheetPage, type PictureSplit } from "./plates";
import type { ExploreSearch } from "./query";
import { ReadingProvider } from "./Reading";
import { StatedLine } from "./Stated";
import type { ExplorePlate } from "./sort";

/** The head for both Explore routes, so the tab reads the same whichever drew the page. */
export async function exploreMetadata(locale: string): Promise<Metadata> {
  const t = await getTranslations({ locale, namespace: "explore" });
  return { title: t("title"), description: t("lede") };
}

/**
 * Which sheet a search asks for, as one string the grid is keyed on.
 *
 * The grid holds its plates and its cursor from the first page it was handed,
 * and every chip shares the /explore/view route, so without a key a new chip
 * kept the old grid: All after Test images showed the test cards with no Load
 * more. A JSON array rather than a joined string, so a search term carrying the
 * separator can never make two different searches read as one.
 */
export function sheetKey(search: ExploreSearch): string {
  return JSON.stringify([search.view, search.search, search.agent, search.ai]);
}

/**
 * The registry as a contact sheet: every passport on Monad, newest first, with
 * the chips that narrow it and the search that finds one.
 *
 * Two routes draw this. The view a bare address opens on is made when the site
 * is built and kept for a minute, so the first visitor after a deploy is handed
 * the pictures rather than a scan of the index and a gateway read for every row
 * it walks past. An address that names a chip, a term or an agent is drawn on
 * the request. They share this component, so what the two of them show can
 * never drift apart.
 *
 * Nothing here is a sample. The rows, the counts and the marks all come from
 * the index. The sheet opens on the pictures, the seed cards the scripts wrote
 * are one chip away rather than hidden, and the line under the counts says how
 * the registry divides between the two.
 */
export async function ExploreSheet({
  locale,
  search,
  stored,
}: {
  locale: string;
  search: ExploreSearch;
  /** True where this render is kept and served to everybody for the next minute. */
  stored: boolean;
}) {
  let plates: ExplorePlate[] = [];
  let cursor: PassportCursor | null = null;
  let gridError: string | null = null;
  let counts: RegistryCounts | null = null;
  let countsError: string | null = null;
  let split: PictureSplit | null = null;

  const [page, totals, divide] = await Promise.allSettled([
    sheetPage(search),
    heldRegistryCounts(),
    heldPictureSplit(),
  ]);

  if (page.status === "fulfilled") {
    plates = page.value.plates;
    cursor = page.value.cursor;
  } else {
    gridError = reason(page.reason);
  }

  if (divide.status === "fulfilled") {
    split = divide.value;
  }

  if (totals.status === "fulfilled") {
    counts = totals.value;
  } else {
    countsError = reason(totals.reason);
  }

  if (stored && (gridError !== null || countsError !== null)) {
    // A read that failed once must never become the page everybody is handed
    // for the next minute, the way a passport the registry has not heard of is
    // never kept. Asking for the connection takes this render out of the
    // store: a build leaves the page to be drawn on the request instead, and a
    // refresh keeps the last good page it already has and tries again on the
    // next request. The split line is left out of this: without it the page is
    // only missing one sentence, and it says nothing wrong.
    await connection();
  }

  return (
    <div className="mx-auto w-full max-w-[1400px] px-5 pb-16 pt-4 sm:px-8 sm:py-24 lg:pt-9">
      <Masthead
        locale={locale}
        counts={counts}
        countsError={countsError}
        split={split}
        view={search.view}
      />
      {/* The chips and the grid share one piece of state: whether the sheet on
          screen is still the one the chips say it is. */}
      <ReadingProvider>
        <Filters search={search} />
        <StatedLine ai={search.ai} />
        {/* The empty sheet is drawn here and handed in, so the grid itself
            never has to load the site's navigation. */}
        <Grid key={sheetKey(search)} first={plates} cursor={cursor} search={search} indexError={gridError} empty={<NoMatch search={search} />} />
      </ReadingProvider>
    </div>
  );
}
