"use server";

import { revalidateTag } from "next/cache";
import type { Hex } from "viem";
import { passportTag } from "@/lib/chain/registry";

const ID_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/**
 * Drops everything the site is holding about one passport.
 *
 * A passport page is built once and handed to everybody who asks for it inside
 * the minute that follows. That is right for a stranger reading a record and
 * wrong for the person who just changed it, so the three writes that change a
 * passport call this before they ask the page to read itself again.
 *
 * Anyone on the internet can call this, so it takes an id and nothing else, and
 * an id that is not a bytes32 is dropped rather than turned into a name. The
 * worst a caller can do with a real id is make the site read the chain again.
 */
export async function refreshPassport(id: string): Promise<void> {
  if (!ID_PATTERN.test(id)) {
    return;
  }
  // Expire now, not at the end of a stale window. Next 16 reads a second
  // argument as a cache life profile and hands the old page out while it
  // rebuilds, which is exactly the page the person who just wrote must not get.
  revalidateTag(passportTag(id as Hex), { expire: 0 });
}
