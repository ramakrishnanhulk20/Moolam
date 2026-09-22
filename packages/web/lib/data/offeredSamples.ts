import { unstable_cache } from "next/cache";
import type { Hex } from "viem";
import { heldStory } from "@/components/story/data";
import { CACHE_TAGS, HOLD_SECONDS } from "@/lib/chain/client";
import { askIndex, heldArt } from "@/lib/data/passports";
import { pickSamples, type SampleMark, type TrySample } from "./samples";

/**
 * The three registered pictures the verify page offers, read on the server.
 *
 * The pictures themselves are the home panel's own list, from the same held
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
 * reads a minute however many people open the page. An index that will not
 * answer costs the ordering and the titles, never the row: the plates are still
 * the newest real pictures and still verify for real.
 */
export async function offeredSamples(limit = 3): Promise<OfferedSamples> {
  const story = await heldStory();
  const plates = story.plates.slice(0, CANDIDATES);
  if (plates.length === 0) {
    return { samples: [], error: story.error };
  }

  const rows = await heldRows(plates.map((plate) => plate.id.toLowerCase()));
  const picked = pickSamples(plates, marksFor(plates.map((plate) => plate.id), rows), limit);

  const samples = await Promise.all(
    picked.map(async (sample) => {
      const uri = rows[sample.id.toLowerCase()]?.metadataURI;
      if (uri === undefined) {
        return sample;
      }
      const art = await heldArt(uri).catch(() => ({ title: undefined }));
      return art.title === undefined ? sample : { ...sample, title: art.title };
    }),
  );

  return { samples, error: story.error };
}

/**
 * What the index says about the candidates, filed by id, held for a minute.
 *
 * An index that answers nothing is an empty map rather than a failure: the
 * samples are picked from the story's own plates, and this read only decides
 * which three of them go first.
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
