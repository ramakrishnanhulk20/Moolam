import type { Hex } from "viem";
import { pinnedUri } from "@/components/passport/art";
import { gatewayUrl } from "@/lib/chain/client";
import { getPassport } from "@/lib/chain/registry";
import { passportArt } from "@/lib/studio/metadata";

export interface ClaimArt {
  title?: string;
  imageUrl?: string;
}

/**
 * The title and picture a delivered passport shows on the confirm card.
 *
 * The service sends no preview for a picture already accepted, so the card
 * reads the registry's metadata address and holds it, and the picture inside
 * it, to the site's one pinned-picture rule before anything is fetched: a
 * platform chose that address (P36). Anything else, or a gateway that fails,
 * costs the picture and never the row, which always shows its passport id.
 */
export async function artFor(id: Hex, timeoutMs = 8_000): Promise<ClaimArt> {
  try {
    const passport = await getPassport(id);
    const document = passport === null ? undefined : pinnedUri(passport.metadataURI);
    if (document === undefined) return {};
    const response = await fetch(gatewayUrl(document), { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return {};
    const art = passportArt(await response.json());
    const picture = art.uri === undefined ? undefined : pinnedUri(art.uri);
    return { title: art.title, imageUrl: picture === undefined ? undefined : gatewayUrl(picture) };
  } catch {
    return {};
  }
}

/** An offer's preview picture through the same rule; undefined draws "no preview". */
export function previewUrl(image: string | undefined): string | undefined {
  if (image === undefined) return undefined;
  const pinned = pinnedUri(image);
  return pinned === undefined ? undefined : gatewayUrl(pinned);
}
