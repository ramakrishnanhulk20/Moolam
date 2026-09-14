import { readArt } from "@/components/passport/art";
import {
  passportMetadata,
  SPLIT_CAP,
  type ExplorePassport,
  type PassportPictures,
} from "@/lib/data/passports";
import { isTestCard, type ExplorePlate } from "./sort";

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
      const art = row.metadataURI === "" ? null : await readArt(row.metadataURI);
      return {
        id: row.id,
        kind: row.kind,
        registeredAt: Number(row.registeredAt),
        title: art?.title ?? null,
        thumbnailUrl: art?.thumbnailUrl ?? null,
        manifest: row.manifest,
        rechecked: row.rechecked,
        chainlink: row.chainlink,
        disputed: row.disputed,
        agentId: row.generatorId,
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
 */
export function plateSheet(pictures: PassportPictures | undefined): PlateSheet {
  const built = new Map<string, ExplorePlate>();

  return {
    keep: async (rows) => {
      for (const plate of await buildPlates(rows)) {
        built.set(plate.id, plate);
      }
      if (pictures === undefined) {
        return rows;
      }
      return rows.filter((row) => isTestCard(built.get(row.id)?.title ?? null) === (pictures === "test"));
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
        const art = row.metadataURI === "" ? null : await readArt(row.metadataURI);
        return art?.title ?? null;
      }),
    );
    real += wave.filter((title) => !isTestCard(title)).length;
  }

  return { real, test: rows.length - real, scanned: rows.length, capped: rows.length >= SPLIT_CAP };
}
