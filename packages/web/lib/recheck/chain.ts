"use server";

import { unstable_cache } from "next/cache";
import type { Hex } from "viem";
import { CACHE_TAGS } from "@/lib/chain/client";
import { isChainlinkReceiver } from "@/lib/chain/receivers";
import { getAttestations, passportTag } from "@/lib/chain/registry";

const ID_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/**
 * Held for half a minute. The control asks at most once a minute per open tab
 * while a finished run waits for the chain, so this caps what a page left open,
 * or a stranger calling the action directly, costs the RPC to two reads a
 * minute for any one passport.
 */
const HOLD_SECONDS = 30;

/**
 * When the newest Chainlink re-check on a passport was written, in unix
 * seconds, or null when the registry holds none.
 *
 * This is the chain check the re-check control makes before it says "done"
 * (R10). It reads the registry itself rather than the index or the verify
 * service, and a row from a writer the app cannot name does not count: a
 * finished request is Moolam's own run, and only a Chainlink receiver's row
 * can be its verdict. Anyone on the internet can call this, so it takes an id
 * and nothing else, and an id that is not a bytes32 reads as nothing held.
 */
export async function newestChainlinkRecheck(id: string): Promise<number | null> {
  if (!ID_PATTERN.test(id)) {
    return null;
  }
  const passport = id as Hex;
  const held = unstable_cache(
    async () => {
      const rows = await getAttestations(passport);
      const times = rows.filter((row) => isChainlinkReceiver(row.receiver)).map((row) => Number(row.at));
      return times.length === 0 ? null : Math.max(...times);
    },
    ["moolam-recheck-on-chain", passport.toLowerCase()],
    { revalidate: HOLD_SECONDS, tags: [CACHE_TAGS.chain, passportTag(passport)] },
  );
  return await held();
}
