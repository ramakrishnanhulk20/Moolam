import type { Hex } from "viem";
import { readArt } from "@/components/passport/art";
import { getPassport } from "@/lib/chain/registry";

/** The few facts the answer card shows about the passport an image matched. */
export interface MatchedPassport {
  id: Hex;
  kind: number;
  /** Seconds since the epoch, as a string: the card only ever prints it. */
  registeredAt: string;
  creator: Hex;
  generatorAgentId: string;
  disputed: boolean;
  title?: string;
  thumbnailUrl?: string;
  /** True when the registered picture was never published, so there is no copy to show. */
  sealed?: boolean;
  /** The block hash on the chain, which is what a sealed answer draws in place of the picture. */
  blockhash256?: Hex;
}

const ID_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/**
 * Looks up the passport the verify service named.
 *
 * The service answers with an id and nothing else, so the rest is read from the
 * chain and the gateway. This runs in the browser on purpose: the verify page
 * is meant to reach the verify service and Monad directly, and a server action
 * here would put the app's own server back in the middle of a check that is not
 * supposed to pass through it.
 *
 * Null means the id is malformed or the registry does not have it, which the
 * card says plainly rather than showing an empty row.
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
    sealed: art.sealed === true,
    blockhash256: passport.blockhash256,
  };
}
