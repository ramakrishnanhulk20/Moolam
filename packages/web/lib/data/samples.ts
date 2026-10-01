import type { Hex } from "viem";
import { isTestCard } from "@/components/explore/sort";
import { SHOWCASE, type ShowcasePick } from "./showcase";

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
 * What a page read for one showcase pick: the picture and the title its pinned
 * document carries, each null where it could not be read.
 */
export interface PickedPlate {
  id: Hex;
  picture: string | null;
  title: string | null;
}

/**
 * The pictures to offer, best first.
 *
 * The showcase picks lead, each in its own slot. A pick holds its slot only
 * when the page read its picture, its document still carries the title it was
 * picked under, and it is no test card; a pick nobody read, or that fails any
 * of those, gives up its slot rather than leaving a gap.
 *
 * Every other slot is filled from the live plates in the order the index gave
 * them, newest first, one per picture so the row is never the same image
 * twice. With no picks read and no marks to go on that is the whole rule and
 * the newest three win, which is what the home panel has always shown.
 *
 * Marks only reorder the fill. A picture whose holder has stated what AI may do
 * with it, and which an independent workflow has re-checked, is the one that
 * shows this product at its best, so it fills first. Nothing is added to the
 * list and nothing is dropped from it by a mark, so a day when the index cannot
 * be reached costs the picks and the order and never the row.
 */
export function pickSamples(
  plates: readonly SamplePlate[],
  marks: SampleMarks = {},
  limit = 3,
  picked: readonly PickedPlate[] = [],
  showcase: readonly ShowcasePick[] = SHOWCASE,
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

  const fill = candidates
    .map((sample, order) => ({ sample, order }))
    .sort((one, two) => strength(two.sample, marks) - strength(one.sample, marks) || one.order - two.order)
    .map(({ sample }) => sample);

  const used = new Set<string>();
  const slots: (TrySample | null)[] = Array.from({ length: limit }, (_, slot) => {
    const pick = showcase[slot];
    const read = pick === undefined ? undefined : picked.find((one) => one.id.toLowerCase() === pick.id.toLowerCase());
    if (pick === undefined || read === undefined || !holds(pick, read) || used.has(read.picture)) {
      return null;
    }
    used.add(read.picture).add(pick.id.toLowerCase());
    return { id: pick.id, url: read.picture, title: pick.title };
  });

  const offered: TrySample[] = [];
  for (const slot of slots) {
    const sample = slot ?? fill.find((one) => !used.has(one.url) && !used.has(one.id.toLowerCase()));
    if (sample === undefined) {
      continue;
    }
    used.add(sample.url).add(sample.id.toLowerCase());
    offered.push(sample);
  }
  return offered;
}

/**
 * Whether a pick still is what it was picked as. The title is the check that
 * the document behind the id is the chosen picture, and a test card never
 * stands in front of a judge, whatever it was picked under.
 */
function holds(pick: ShowcasePick, read: PickedPlate): read is PickedPlate & { picture: string } {
  return read.picture !== null && read.title === pick.title && !isTestCard(read.title, pick.id);
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
