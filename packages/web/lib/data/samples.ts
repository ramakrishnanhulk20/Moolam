import type { Hex } from "viem";

/**
 * Which registered pictures a panel offers to try, and the one rule both panels
 * pick them by.
 *
 * A judge arrives with no Moolam picture on their laptop. Both the home panel
 * and the verify page hand them real registered pictures instead, and they have
 * to be the same three: two lists built by two rules would show a judge one
 * picture on the first screen and a different one on the page the header sends
 * them to. So the rule lives here, on its own, with nothing server side in it,
 * and both sides call it.
 */

/** One registered picture a panel offers, and where its bytes are pinned. */
export interface TrySample {
  id: Hex;
  /** The pinned picture, as a gateway address. Pressing the plate fetches these bytes. */
  url: string;
  /** The name pinned with the picture, when the page that offers it has read the document. */
  title?: string;
}

/** What is known about one candidate beyond its picture, when a page has asked. */
export interface SampleMark {
  /** True when the holder has written a statement about AI use for this passport. */
  stated: boolean;
  /** True when at least one independent re-check has already been written for it. */
  rechecked: boolean;
  title?: string;
}

/** The marks a page read, filed under the lowercased passport id. */
export type SampleMarks = Readonly<Record<string, SampleMark>>;

/** The least a plate has to carry to be offered: a passport and a picture. */
export interface SamplePlate {
  id: Hex;
  picture: string;
}

/**
 * The pictures to offer, best first.
 *
 * The candidates are the live plates in the order the index gave them, newest
 * first, one per picture so the row is never the same image three times. With
 * no marks to go on that is the whole rule and the newest three win, which is
 * what the home panel has always shown.
 *
 * Marks only reorder what is already there. A picture whose holder has stated
 * what AI may do with it, and which an independent workflow has re-checked, is
 * the one that shows this product at its best, so it goes first. Nothing is
 * added to the list and nothing is dropped from it by a mark, so a day when the
 * index cannot be reached costs the order and never the row.
 */
export function pickSamples(
  plates: readonly SamplePlate[],
  marks: SampleMarks = {},
  limit = 3,
): TrySample[] {
  const seen = new Set<string>();
  const candidates: TrySample[] = [];

  for (const plate of plates) {
    if (seen.has(plate.picture)) {
      continue;
    }
    seen.add(plate.picture);
    const title = marks[plate.id.toLowerCase()]?.title;
    candidates.push(title === undefined ? { id: plate.id, url: plate.picture } : { id: plate.id, url: plate.picture, title });
  }

  return candidates
    .map((sample, order) => ({ sample, order }))
    .sort((one, two) => strength(two.sample, marks) - strength(one.sample, marks) || one.order - two.order)
    .slice(0, limit)
    .map(({ sample }) => sample);
}

/**
 * How well one picture shows the product. A re-check outranks a statement
 * because it is the harder fact: somebody else fetched the picture and
 * recomputed its fingerprint.
 */
function strength(sample: TrySample, marks: SampleMarks): number {
  const mark = marks[sample.id.toLowerCase()];
  if (mark === undefined) {
    return 0;
  }
  return (mark.rechecked ? 2 : 0) + (mark.stated ? 1 : 0);
}
