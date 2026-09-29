import { unstable_cache } from "next/cache";
import type { Hex } from "viem";
import { METADATA_HOLD_SECONDS } from "@/lib/chain/client";
import { CHILD_PAGE_SIZE, getPassport, passportTag } from "@/lib/chain/registry";
import { heldArt } from "@/lib/data/passports";
import { recordUnread } from "./unread";

/** What the lineage draws for one relative: its name and its small picture, when they could be read. */
export interface FamilyMember {
  title?: string;
  thumbnailUrl?: string;
}

/** Relatives by lowercased id. An id missing here is drawn by its short id alone. */
export type Family = Record<string, FamilyMember>;

const NO_SUCH_PASSPORT = "moolam: no such passport";

/**
 * The document address of one passport, held for a day. It is written once at
 * registration and never changes, so a day of holding it costs nothing. A
 * miss is never held, so a passport registered a moment ago is found.
 */
async function documentOf(id: Hex): Promise<string | null> {
  const read = async () => (await getPassport(id))?.metadataURI ?? null;
  const held = unstable_cache(
    async () => {
      const uri = await read();
      if (uri === null) {
        throw new Error(NO_SUCH_PASSPORT);
      }
      return uri;
    },
    ["moolam-family-document", id.toLowerCase()],
    { revalidate: METADATA_HOLD_SECONDS, tags: [passportTag(id)] },
  );
  try {
    return await held();
  } catch (error) {
    if ((error as Error | undefined)?.message === NO_SUCH_PASSPORT) {
      return null;
    }
    // Anywhere there is no cache to hold it in, the chain is simply asked.
    return await read();
  }
}

async function memberOf(id: Hex): Promise<FamilyMember | null> {
  try {
    const uri = await documentOf(id);
    if (uri === null) {
      return null;
    }
    const art = await heldArt(uri, id);
    // A document no gateway handed over has no title to show, and "Untitled"
    // would say its creator gave none, so it keeps its id instead.
    return recordUnread(art) ? null : { title: art.title, thumbnailUrl: art.thumbnailUrl };
  } catch {
    return null;
  }
}

/**
 * Names and small pictures for the passport this one was edited from and for
 * the edits made from it, so the family reads as pictures rather than hashes.
 *
 * Each relative costs one chain read and one pinned document, both held, and a
 * relative that cannot be read costs its own name and nothing else. Only the
 * first page's worth are named: the list itself has no cap on chain, and a
 * stranger could otherwise decide how many reads this page makes.
 */
export async function familyOf(ids: readonly Hex[]): Promise<Family> {
  if (ids.length === 0) {
    return {};
  }
  const named = ids.slice(0, CHILD_PAGE_SIZE);
  const members = await Promise.all(named.map(async (id) => [id.toLowerCase(), await memberOf(id)] as const));
  const family: Family = {};
  for (const [id, member] of members) {
    if (member !== null) {
      family[id] = member;
    }
  }
  return family;
}
