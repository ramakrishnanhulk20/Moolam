import { unstable_cache } from "next/cache";
import { CACHE_TAGS, HOLD_SECONDS } from "@/lib/chain/client";
import { disputedReach } from "@/lib/data/lineage";
import {
  EXPLORE_PAGE,
  explorePassports,
  heldArt,
  passportMetadata,
  SPLIT_CAP,
  type ExplorePassport,
  type PassportCursor,
  type PassportPictures,
} from "@/lib/data/passports";
import { filterFor, picturesFor, type ExploreSearch } from "./query";
import { answersTerm, searchesTitles } from "./search";
import { isTestCard, type ExplorePlate } from "./sort";

/**
 * Whether a passport's pinned record never reached this server: no document at
 * all, or a gateway that gave back nothing with a title in it. Such a plate has
 * no title to judge, so it is judged by its passport's own kind and stays a
 * picture, rather than turning into a test card for a gateway's bad minute.
 */
export function recordUnread(art: { missing: boolean; title?: string } | null): boolean {
  return art === null || (art.missing && art.title === undefined);
}

/**
 * The index's rows with the picture each one points at.
 *
 * One gateway read per row, run together, and every read already fails soft:
 * a row whose metadata will not load keeps its id, its kind and its marks and
 * shows the seal on a dark plate instead of a broken image.
 *
 * Numbers cross to the browser as plain ones on purpose. A second since the
 * epoch and an agent id both fit, and a bigint cannot travel from a server
 * component to a client one at all.
 */
export async function buildPlates(rows: ExplorePassport[]): Promise<ExplorePlate[]> {
  return await Promise.all(
    rows.map(async (row) => {
      // The id goes with the address: a sealed row's picture may have been
      // published since, and the record that says so is filed under the
      // passport rather than under the document.
      const art = row.metadataURI === "" ? null : await heldArt(row.metadataURI, row.id);
      return {
        id: row.id,
        kind: row.kind,
        registeredAt: Number(row.registeredAt),
        title: art?.title ?? null,
        thumbnailUrl: art?.thumbnailUrl ?? null,
        manifest: row.manifest,
        rechecked: row.rechecked,
        chainlink: row.chainlink,
        disputed: row.inheritedDisputed,
        agentId: row.generatorId,
        consent: row.consent,
        sealed: art?.sealed === true,
        blockhash: art?.blockhash,
        unread: recordUnread(art),
      };
    }),
  );
}

/** The sieve the index reads through, and the plates it built on the way. */
export interface PlateSheet {
  /** Which rows of one scanned page belong under the chip the reader is on. */
  keep: (rows: ExplorePassport[]) => Promise<ExplorePassport[]>;
  /** The plates for the rows that came back, already built during the scan. */
  platesFor: (rows: ExplorePassport[]) => ExplorePlate[];
}

/**
 * The sieve that separates the real pictures from the seed test cards.
 *
 * The split is a title, and a title lives in the pinned metadata rather than in
 * the index, so the rows have to be turned into plates before they can be
 * judged. Every plate it builds is held, so a page that is scanned and then
 * drawn reads the gateway once per row rather than once per pass. The test is
 * the same isTestCard the sort rule uses, so the chip and the order can never
 * disagree about what a test card is.
 *
 * `answers` is the second sieve a title search adds, read off the same plates,
 * so a title costs no gateway read the sheet was not already making.
 */
export function plateSheet(
  pictures: PassportPictures | undefined,
  answers?: (plate: ExplorePlate) => boolean,
): PlateSheet {
  const built = new Map<string, ExplorePlate>();

  return {
    keep: async (rows) => {
      for (const plate of await buildPlates(rows)) {
        built.set(plate.id, plate);
      }
      return rows.filter((row) => {
        const plate = built.get(row.id);
        if (answers !== undefined && (plate === undefined || !answers(plate))) {
          return false;
        }
        return (
          pictures === undefined ||
          isTestCard(plate?.title ?? null, row.id, plate?.unread ?? true) === (pictures === "test")
        );
      });
    },
    platesFor: (rows) => rows.map((row) => built.get(row.id)).filter((plate): plate is ExplorePlate => plate !== undefined),
  };
}

/** How the registry divides: pictures a reader can look at, and the scripts' test cards. */
export interface PictureSplit {
  real: number;
  test: number;
  /** How many rows were read to get those two numbers. */
  scanned: number;
  /** True when the read stopped at the cap, so the two numbers cover the newest rows only. */
  capped: boolean;
}

/** How many metadata documents are read at once, so a whole registry does not hit the gateway in one wave. */
const SPLIT_WAVE = 16;

/**
 * The one line under the counts: how much of the registry is pictures and how
 * much is the seed test cards.
 *
 * Every metadata document in the index is read for its title, in waves. They are
 * the same documents the grid reads, so within one render the gateway serves
 * each one once.
 */
export async function pictureSplit(): Promise<PictureSplit> {
  const rows = await passportMetadata();

  let real = 0;
  for (let at = 0; at < rows.length; at += SPLIT_WAVE) {
    const wave = await Promise.all(
      rows.slice(at, at + SPLIT_WAVE).map(async (row) => {
        const art = row.metadataURI === "" ? null : await heldArt(row.metadataURI);
        return isTestCard(art?.title ?? null, row.id, recordUnread(art));
      }),
    );
    real += wave.filter((test) => !test).length;
  }

  return { real, test: rows.length - real, scanned: rows.length, capped: rows.length >= SPLIT_CAP };
}

/**
 * The same line, held for a minute. It reads the title of every document in the
 * index, so it is the most expensive thing on the page and the least urgent:
 * one new passport does not move either number by anything a reader would see.
 */
export const heldPictureSplit = unstable_cache(async () => await pictureSplit(), ["moolam-picture-split"], {
  revalidate: HOLD_SECONDS,
  tags: [CACHE_TAGS.index],
});

/** One page of the sheet, exactly as the grid draws it. */
export interface SheetPage {
  plates: ExplorePlate[];
  cursor: PassportCursor | null;
}

/**
 * How many rows one page of a title search reads: every passport today, since
 * the registry holds 43, and the same cap the split line reads under.
 */
export const TITLE_SCAN = SPLIT_CAP;

/**
 * One page of a search by title.
 *
 * The index cannot match a title, so this asks it once for every row the chips
 * allow from the cursor on, reads each title through the held documents the
 * sheet already reads, and keeps the rows whose title or id holds the term. One
 * index query per page, the same as any other sheet. A page is cut at the same
 * size as any other, and the cursor then points at its last row, so Load more
 * carries on from there; a scan that stopped at the cap hands back the index's
 * own cursor instead.
 */
async function titleSheet(search: ExploreSearch, cursor: PassportCursor | null): Promise<SheetPage> {
  const sheet = plateSheet(picturesFor(search.view), (plate) => answersTerm(search.search, plate.id, plate.title));
  const filter = filterFor({ ...search, search: "" });
  // The halves are sifted by the sheet above. Left on the filter, a search that
  // matched a handful of rows would page on through the whole index for more.
  delete filter.pictures;

  const page = await explorePassports({
    filter: { ...filter, disputedReach: await disputedReach() },
    cursor,
    limit: TITLE_SCAN,
    keep: sheet.keep,
  });

  const matched = page.passports;
  if (matched.length > EXPLORE_PAGE) {
    const last = matched[EXPLORE_PAGE - 1];
    return {
      plates: sheet.platesFor(matched.slice(0, EXPLORE_PAGE)),
      cursor: { registeredAt: String(last.registeredAt), id: last.id },
    };
  }
  return { plates: sheet.platesFor(matched), cursor: page.cursor };
}

const heldSheet = unstable_cache(
  async (
    view: ExploreSearch["view"],
    search: string,
    agent: string | null,
    ai: ExploreSearch["ai"],
    cursor: PassportCursor | null,
  ) => {
    if (searchesTitles(search)) {
      return await titleSheet({ view, search, agent, ai }, cursor);
    }
    const sheet = plateSheet(picturesFor(view));
    // Worked out once for the whole page rather than per row: the chip needs it
    // for its query, and every other chip needs it to light the D on an edit
    // whose picture was disputed.
    const filter = { ...filterFor({ view, search, agent, ai }), disputedReach: await disputedReach() };
    const page = await explorePassports({ filter, cursor, keep: sheet.keep });
    return { plates: sheet.platesFor(page.passports), cursor: page.cursor };
  },
  ["moolam-explore-sheet"],
  { revalidate: HOLD_SECONDS, tags: [CACHE_TAGS.index] },
);

/**
 * One page of the sheet under one set of chips, held for a minute.
 *
 * The sieve is the expensive half of Explore: a scan of the index and a gateway
 * read for every row it walks past, all of it to answer a question that is the
 * same for everybody looking at that view. The whole answer is held rather than
 * its parts, because the reader's chips are what decide which rows were read.
 * Everything in it is a string, a number or a flag, so it survives the cache;
 * that is why the grid is drawn from plates and not from index rows.
 */
export async function sheetPage(search: ExploreSearch, cursor: PassportCursor | null = null): Promise<SheetPage> {
  return await heldSheet(search.view, search.search, search.agent, search.ai, cursor);
}
