import { unstable_cache } from "next/cache";
import type { Hex } from "viem";
import { heldStory } from "@/components/story/data";
import { CACHE_TAGS, HOLD_SECONDS } from "@/lib/chain/client";
import { askIndex, heldArt } from "@/lib/data/passports";
import { pickSamples, type PickedPlate, type SampleMark, type TrySample } from "./samples";
import { SHOWCASE } from "./showcase";

/**
 * The three registered pictures the home page and the verify page offer, read
 * on the server.
 *
 * The three are the hand-picked showcase set, read by id, and each slot whose
 * pick cannot be read is filled from the home panel's own list, the same held
 * story read, so the two screens can never offer a judge different pictures.
 * What is added here is what the page needs to put a name and a reason under
 * each one: the title pinned with the picture, whether its holder has said
 * anything about AI use, and whether anything has re-checked it.
 */

/** How many of the newest plates are weighed before three are offered. */
const CANDIDATES = 6;

/**
 * The five summary words the index writes for a statement, which is also the
 * list lib/data/passports reads one back with. Anything outside it is a
 * statement this build cannot read, and silence is the only answer that can
 * never claim a permission nobody gave.
 */
const SUMMARY_WORDS = new Set(["open", "closed", "ask", "mixed", "none"]);

/** One candidate as the index has it. The title is read separately, from the pinned document. */
interface SampleRow {
  id: string;
  metadataURI: string;
  attestationCount: number;
  consentStated: boolean;
  consentSummary: string;
}

const SAMPLE_ROWS = `query SampleRows($ids: [String!]!) {
  Passport(where: { id: { _in: $ids } }) {
    id
    metadataURI
    attestationCount
    consentStated
    consentSummary
  }
}`;

/** The row of pictures, and the story's own words when nothing could be read at all. */
export interface OfferedSamples {
  samples: TrySample[];
  /** Null on a good read, including a registry that genuinely holds no pictures yet. */
  error: string | null;
}

/**
 * The pictures to offer, with their names.
 *
 * Every read in here is held, and the page above it is rebuilt a minute at a
 * time, so offering samples costs one index query and a handful of gateway
 * reads a minute however many people open the page. The picks ride in that one
 * query beside the candidates, never a query each. An index that will not
 * answer costs the picks, the ordering and the titles, never the row: the
 * plates are still the newest real pictures and still verify for real.
 */
export async function offeredSamples(limit = 3): Promise<OfferedSamples> {
  const story = await heldStory();
  const plates = story.plates.slice(0, CANDIDATES);
  if (plates.length === 0) {
    return { samples: [], error: story.error };
  }

  const ids = [...new Set([...plates, ...SHOWCASE].map((entry) => entry.id.toLowerCase()))];
  const rows = await heldRows(ids);
  const picks = await Promise.all(SHOWCASE.map((pick) => pickRead(pick.id, rows)));
  const chosen = pickSamples(plates, marksFor(plates.map((plate) => plate.id), rows), limit, picks);

  const samples = await Promise.all(
    chosen.map(async (sample) => {
      const uri = rows[sample.id.toLowerCase()]?.metadataURI;
      if (sample.title !== undefined || uri === undefined) {
        return sample;
      }
      const art = await heldArt(uri).catch(() => ({ title: undefined }));
      return art.title === undefined ? sample : { ...sample, title: art.title };
    }),
  );

  return { samples, error: story.error };
}

/**
 * The picture and the title one pick's document carries, or nulls where it
 * could not be read. The picture is the small copy, the same one the story's
 * plates are drawn from, so a pick that is also among the newest is the same
 * address and can never be offered twice.
 */
async function pickRead(id: Hex, rows: Record<string, SampleRow>): Promise<PickedPlate> {
  const uri = rows[id.toLowerCase()]?.metadataURI;
  if (uri === undefined) {
    return { id, picture: null, title: null };
  }
  const art = await heldArt(uri).catch(() => ({ title: undefined, thumbnailUrl: undefined }));
  return { id, picture: art.thumbnailUrl ?? null, title: art.title ?? null };
}

/**
 * What the index says about the candidates, filed by id, held for a minute.
 *
 * The candidates and the showcase picks are asked for in the one query. An
 * index that answers nothing is an empty map rather than a failure: every pick
 * then reads as unread and gives up its slot to the story's own plates.
 */
async function heldRows(ids: string[]): Promise<Record<string, SampleRow>> {
  const held = unstable_cache(async () => await sampleRows(ids), ["moolam-sample-rows", ids.join(",")], {
    revalidate: HOLD_SECONDS,
    tags: [CACHE_TAGS.index],
  });

  try {
    return await held();
  } catch {
    return {};
  }
}

async function sampleRows(ids: string[]): Promise<Record<string, SampleRow>> {
  const data = await askIndex<{ Passport: SampleRow[] }>(SAMPLE_ROWS, { ids });
  return Object.fromEntries(data.Passport.map((row) => [row.id.toLowerCase(), row]));
}

/**
 * Whether each candidate carries a statement and a re-check.
 *
 * Both come off the one index row. The register on Monad holds the same
 * statement, but asking it costs one chain read per candidate to decide the
 * order of three pictures, and the index has flattened the answer onto the
 * passport already. A candidate with no row, which is what an index that would
 * not answer leaves behind, reads as neither: a missing mark costs the order
 * and never the row.
 */
function marksFor(ids: Hex[], rows: Record<string, SampleRow>): Record<string, SampleMark> {
  return Object.fromEntries(
    ids.map((id) => {
      const row = rows[id.toLowerCase()];
      return [
        id.toLowerCase(),
        {
          stated: row !== undefined && row.consentStated && SUMMARY_WORDS.has(row.consentSummary),
          rechecked: (row?.attestationCount ?? 0) > 0,
        },
      ] as const;
    }),
  );
}
