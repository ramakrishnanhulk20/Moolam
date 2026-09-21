import { unstable_cache } from "next/cache";
import type { Hex } from "viem";
import { heldStory } from "@/components/story/data";
import { CACHE_TAGS, HOLD_SECONDS } from "@/lib/chain/client";
import { heldConsent } from "@/lib/chain/consent";
import { heldArt } from "@/lib/data/passports";
import { envioUrl } from "@/lib/data/source";
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

/** One candidate as the index has it. The title is read separately, from the pinned document. */
interface SampleRow {
  id: string;
  metadataURI: string;
  attestationCount: number;
}

const SAMPLE_ROWS = `query SampleRows($ids: [String!]!) {
  Passport(where: { id: { _in: $ids } }) {
    id
    metadataURI
    attestationCount
  }
}`;

/**
 * The pictures to offer, with their names.
 *
 * Every read in here is held, and the page above it is rebuilt a minute at a
 * time, so offering samples costs one index query and a handful of register
 * reads a minute however many people open the page. An index or a register that
 * will not answer costs the ordering and the titles, never the row: the plates
 * are still the newest real pictures and still verify for real.
 */
export async function offeredSamples(limit = 3): Promise<TrySample[]> {
  const story = await heldStory();
  const plates = story.plates.slice(0, CANDIDATES);
  if (plates.length === 0) {
    return [];
  }

  const rows = await heldRows(plates.map((plate) => plate.id.toLowerCase()));
  const marks = await marksFor(plates.map((plate) => plate.id), rows);
  const picked = pickSamples(plates, marks, limit);

  return await Promise.all(
    picked.map(async (sample) => {
      const uri = rows[sample.id.toLowerCase()]?.metadataURI;
      if (uri === undefined) {
        return sample;
      }
      const art = await heldArt(uri).catch(() => ({ title: undefined }));
      return art.title === undefined ? sample : { ...sample, title: art.title };
    }),
  );
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
  const response = await fetch(envioUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: SAMPLE_ROWS, variables: { ids } }),
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`the Envio endpoint answered ${response.status}`);
  }

  const body = (await response.json()) as { errors?: { message: string }[]; data?: { Passport: SampleRow[] } };
  if (body.errors !== undefined && body.errors.length > 0) {
    throw new Error(body.errors.map((entry) => entry.message).join("; "));
  }
  if (body.data === undefined) {
    throw new Error("the Envio endpoint returned no data block");
  }

  return Object.fromEntries(body.data.Passport.map((row) => [row.id.toLowerCase(), row]));
}

/**
 * Whether each candidate carries a statement and a re-check.
 *
 * The statement is read from the register on Monad rather than from the index,
 * which does not hold that field yet, and a read that fails reads as no
 * statement: this only orders a row of three pictures, so a wrong guess costs
 * nothing a reader could be misled by.
 */
async function marksFor(ids: Hex[], rows: Record<string, SampleRow>): Promise<Record<string, SampleMark>> {
  const marks = await Promise.all(
    ids.map(async (id) => {
      const reading = await heldConsent(id).catch(() => ({ stated: false }));
      return [
        id.toLowerCase(),
        { stated: reading.stated, rechecked: (rows[id.toLowerCase()]?.attestationCount ?? 0) > 0 },
      ] as const;
    }),
  );

  return Object.fromEntries(marks);
}
