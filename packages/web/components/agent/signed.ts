import { readArt } from "@/components/passport/art";
import { passportsByGenerator, type PassportListing } from "@/lib/data/passports";

/** One passport this agent signed, with the picture the metadata points at. */
export interface SignedWork extends PassportListing {
  title?: string;
  thumbnailUrl?: string;
}

const HOW_MANY = 12;

/**
 * Everything this agent has signed, newest first, from the index.
 *
 * The thumbnails are one gateway fetch per row, run together. A row whose
 * metadata will not load keeps its id and its block instead of disappearing,
 * because the record is real either way.
 */
export async function signedWorks(agentId: bigint): Promise<SignedWork[]> {
  const listings = await passportsByGenerator(agentId, HOW_MANY);

  return await Promise.all(
    listings.map(async (listing) => {
      const art = await readArt(listing.metadataURI);
      return { ...listing, title: art.title, thumbnailUrl: art.thumbnailUrl };
    }),
  );
}
