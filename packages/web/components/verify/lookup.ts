import type { Hex } from "viem";
import { pinnedUri, readArt } from "@/components/passport/art";
import { gatewayUrl } from "@/lib/chain/client";
import { getPassport } from "@/lib/chain/registry";
import { readUnsealRecord } from "@/lib/verifier/client";

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
  /** ISO 8601, set when this passport was registered sealed and published by its holder later. */
  unsealedAt?: string;
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
  // A sealed document says sealed for ever, so a passport whose holder has
  // published the picture since is only knowable from the record filed under
  // its id. This page already talks to the verify service directly, which is
  // the point of it, so it asks there rather than through this app's server.
  const lookup = art.sealed === true ? await readUnsealRecord(passport.id) : ({ state: "sealed" } as const);
  // The same rule as every other picture on the site, and as the server's own
  // read of this record (lib/data/unseal.ts): a record that names anything but
  // a pinned file leaves the answer sealed, so no visitor's browser is sent to
  // a host the record chose.
  const thumbnail = lookup.state === "unsealed" ? pinnedUri(lookup.record.thumbnail.uri) : undefined;
  const published = lookup.state === "unsealed" && thumbnail !== undefined ? lookup.record : null;

  return {
    id: passport.id,
    kind: passport.kind,
    registeredAt: passport.registeredAt.toString(),
    creator: passport.creator,
    generatorAgentId: passport.generatorAgentId.toString(),
    disputed: passport.disputed,
    title: art.title,
    thumbnailUrl: published === null || thumbnail === undefined ? art.thumbnailUrl : gatewayUrl(thumbnail),
    sealed: art.sealed === true && published === null,
    blockhash256: passport.blockhash256,
    unsealedAt: published?.unsealedAt,
  };
}
