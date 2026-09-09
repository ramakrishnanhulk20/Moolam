"use server";

import type { Hex } from "viem";
import { readArt } from "@/components/passport/art";
import { getPassport } from "@/lib/chain/registry";

/** The few facts the answer card shows about the passport an image matched. */
export interface MatchedPassport {
  id: Hex;
  kind: number;
  /** Seconds since the epoch, as a string, because a bigint does not survive the trip. */
  registeredAt: string;
  creator: Hex;
  generatorAgentId: string;
  disputed: boolean;
  title?: string;
  thumbnailUrl?: string;
}

const ID_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/**
 * Looks up the passport the verify service named.
 *
 * The service answers with an id and nothing else, and the registry read lives
 * on the server, so the browser asks for the rest here. Null means the id is
 * malformed or the registry does not have it, which the card says plainly
 * rather than showing an empty row.
 */
export async function matchedPassport(id: string): Promise<MatchedPassport | null> {
  if (!ID_PATTERN.test(id)) {
    return null;
  }

  const passport = await getPassport(id as Hex);
  if (passport === null) {
    return null;
  }

  const art = await readArt(passport.metadataURI);

  return {
    id: passport.id,
    kind: passport.kind,
    registeredAt: passport.registeredAt.toString(),
    creator: passport.creator,
    generatorAgentId: passport.generatorAgentId.toString(),
    disputed: passport.disputed,
    title: art.title,
    thumbnailUrl: art.thumbnailUrl,
  };
}
