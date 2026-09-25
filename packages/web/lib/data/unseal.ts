import { unstable_cache } from "next/cache";
import type { Hex } from "viem";
import { pinnedUri, type Art } from "@/components/passport/art";
import { HOLD_SECONDS, gatewayUrl } from "@/lib/chain/client";
import { passportTag } from "@/lib/chain/registry";
import { readUnsealRecord, type UnsealLookup, type UnsealRecord } from "@/lib/verifier/client";

/**
 * Where the picture of an unsealed passport lives, read on the server.
 *
 * A sealed passport's metadata address is written on chain once and can never
 * change, so its pinned document says sealed for ever, even after the holder
 * has published the picture. The record pinned beside it is the only thing that
 * says otherwise, and it is found by name through the verify service. That is
 * why this read exists at all, and why it belongs on the server: a page that
 * asked from the browser would spend one of the service's shared Pinata
 * requests per reader rather than one per minute for everybody.
 */

const ID_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/** Thrown inside the held read when the service could not find out, so the miss is not kept. */
class LookupSilent extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "LookupSilent";
  }
}

/**
 * The lookup for one passport, held under that passport's own name.
 *
 * A minute is the same window the page, the Explore sheet and the chain reads
 * are already held for, and a write to this passport drops the whole name at
 * once, so the holder who has just published sees their picture on the next
 * render rather than a minute later.
 *
 * Only an answer is held. A service that could not find out is asked again,
 * because remembering "cannot tell" would keep a published picture hidden for
 * as long as the hold lasts.
 */
export async function heldUnseal(id: Hex): Promise<UnsealLookup> {
  if (!ID_PATTERN.test(id)) {
    return { state: "unknown", reason: "that is not a passport id" };
  }

  const held = unstable_cache(
    async () => {
      const lookup = await readUnsealRecord(id);
      if (lookup.state === "unknown") {
        throw new LookupSilent(lookup.reason);
      }
      return lookup;
    },
    ["moolam-unseal-record", id.toLowerCase()],
    { revalidate: HOLD_SECONDS, tags: [passportTag(id)] },
  );

  try {
    return await held();
  } catch (error) {
    if (error instanceof LookupSilent || (error as Error | undefined)?.name === "LookupSilent") {
      return { state: "unknown", reason: error instanceof Error ? error.message : String(error) };
    }
    // Anywhere there is no cache to hold it in, a unit test for one, the
    // service is simply asked. The same rule the pinned documents follow: an
    // answer is worth more than the saving.
    return await readUnsealRecord(id);
  }
}

/**
 * The same document, with the picture back on it when the holder has published
 * one.
 *
 * A published passport passes straight through and costs nothing: only a sealed
 * document is worth a lookup. A lookup that cannot answer leaves the record
 * exactly as it was, drawn as sealed, because a page that guessed "not
 * unsealed" from a service having a bad minute would tell a holder their public
 * picture is private.
 */
export async function withUnseal(art: Art, id?: string): Promise<Art> {
  if (art.sealed !== true) {
    return art;
  }

  // The document names its own passport in the commitment, so a caller that has
  // the id passes it and a caller that only has the document still gets an
  // answer.
  const passportId = id ?? art.commitment?.value;
  if (passportId === undefined || !ID_PATTERN.test(passportId)) {
    return art;
  }

  const lookup = await heldUnseal(passportId as Hex);
  return lookup.state === "unsealed" ? publishedArt(art, lookup.record) : art;
}

/**
 * The document as it reads once the picture is out: the words it always had,
 * the two addresses from the record, and no seal.
 *
 * The addresses are resolved through this app's own gateway rather than the one
 * the service named, so an unsealed picture is fetched exactly like every other
 * picture on the site and gets the same fallbacks when a gateway is slow.
 */
function publishedArt(art: Art, record: UnsealRecord): Art {
  // The same rule as every other picture on the site: only a pinned address is
  // drawn, so a record naming anything else leaves the picture sealed.
  const image = pinnedUri(record.image.uri);
  const thumbnail = pinnedUri(record.thumbnail.uri);
  if (image === undefined || thumbnail === undefined) {
    return art;
  }
  return {
    title: art.title,
    description: art.description,
    prompt: art.prompt,
    imageUrl: gatewayUrl(image),
    thumbnailUrl: gatewayUrl(thumbnail),
    unsealed: {
      at: record.unsealedAt,
      by: record.unsealedBy,
      record: { cid: record.record.cid, uri: record.record.uri },
    },
    missing: false,
  };
}
