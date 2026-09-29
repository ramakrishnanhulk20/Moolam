import { sheetPage } from "@/components/explore/plates";
import { readExploreSearch } from "@/components/explore/query";
import { isTestCard, type ExplorePlate } from "@/components/explore/sort";
import { heldArt, heldPassportsByGenerator, type PassportListing } from "@/lib/data/passports";

/** One passport this agent signed, with the picture the metadata points at. */
export interface SignedWork extends PassportListing {
  title?: string;
  thumbnailUrl?: string;
}

const HOW_MANY = 12;

/**
 * The agent's real pictures ahead of the cards the test scripts wrote, each
 * group keeping the newest first order the index returned. The demo agent's
 * newest rows are all prove-it and seed cards, and a page that opened on those
 * read as a page of test patterns. Nothing is dropped: the test cards follow,
 * and the same rule as Explore decides which is which, so the two never
 * disagree about a picture.
 */
export function realPicturesFirst<T extends { id: string; title?: string }>(works: T[]): T[] {
  const real = works.filter((work) => !isTestCard(work.title ?? null, work.id));
  const tests = works.filter((work) => isTestCard(work.title ?? null, work.id));
  return [...real, ...tests];
}

/**
 * Everything this agent has signed, real pictures first and newest first inside
 * each group, from the index.
 *
 * The thumbnails are one gateway fetch per row, run together, and each one is
 * held under its own content address so the second visitor to this page reads
 * none of them. A row whose metadata will not load keeps its id and its block
 * instead of disappearing, because the record is real either way.
 */
export async function signedWorks(agentId: bigint): Promise<SignedWork[]> {
  const listings = await heldPassportsByGenerator(agentId, HOW_MANY);

  const works = await Promise.all(
    listings.map(async (listing) => {
      const art = await heldArt(listing.metadataURI);
      return { ...listing, title: art.title, thumbnailUrl: art.thumbnailUrl };
    }),
  );
  return realPicturesFirst(works);
}

/** What the agent page draws its pictures from. */
export interface AgentSheet {
  /** The agent's newest passports as Explore's plates, newest first. */
  plates: ExplorePlate[];
  /** True when the read reached the agent's oldest passport, so nothing it signed is missing from the plates. */
  complete: boolean;
}

/**
 * The agent's passports read as the Explore sheet filtered to this agent.
 *
 * The search is built the way Explore reads the "see all its pictures" link,
 * so the page and the sheet that link opens are one held read: the second of
 * the two is answered from the minute the first one bought. The plates are the
 * same records Explore draws, marks and all, which is what keeps a passport
 * looking the same on both pages.
 */
export async function agentSheet(agentId: bigint | string): Promise<AgentSheet> {
  const page = await sheetPage(readExploreSearch({ agent: agentId.toString() }));
  return { plates: page.plates, complete: page.cursor === null };
}

/** The address of that same sheet on Explore. */
export function agentSheetHref(agentId: bigint | string): string {
  return `/explore/view?agent=${agentId.toString()}`;
}

/**
 * The plates split into the real pictures and the test images, each keeping
 * the newest first order, by the same rule Explore sorts with.
 */
export function splitTestPlates(plates: ExplorePlate[]): { real: ExplorePlate[]; tests: ExplorePlate[] } {
  const test = (plate: ExplorePlate) => isTestCard(plate.title, plate.id, plate.unread);
  return { real: plates.filter((plate) => !test(plate)), tests: plates.filter(test) };
}
