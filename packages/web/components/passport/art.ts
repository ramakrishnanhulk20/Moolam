import { z } from "zod";
import { gatewayUrl } from "@/lib/chain/client";

/**
 * The pinned metadata JSON, read for the picture and the words a passport page
 * shows. Only the fields these screens draw are described, so a document
 * written by a later version still renders instead of failing a strict check.
 */
const metadataSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  prompt: z.string().optional(),
  image: z.string().optional(),
  thumbnail: z.string().optional(),
});

export interface Art {
  title?: string;
  description?: string;
  prompt?: string;
  /** The full image, for a poster. */
  imageUrl?: string;
  /** The small copy, for a grid. Falls back to the full image when none was pinned. */
  thumbnailUrl?: string;
  /** True when the gateway did not answer or the document was not readable. */
  missing: boolean;
}

const TIMEOUT_MS = 8_000;

/**
 * The content id inside a stored URI, so a link can be named after what it
 * points at rather than after whichever gateway is reading it today. Null when
 * the URI is not an IPFS one at all.
 */
export function cidOf(uri: string): string | null {
  if (uri.startsWith("ipfs://")) {
    const rest = uri.slice("ipfs://".length);
    return rest.length === 0 ? null : rest;
  }
  const found = /\/ipfs\/([^/?#]+)/.exec(uri);
  return found === null ? null : found[1];
}

/**
 * Reads one passport's metadata through the IPFS gateway.
 *
 * A gateway that is slow, rate limited or missing the document costs the
 * picture, never the page: the caller draws the seal on a dark plate and says
 * so in words rather than leaving a broken image icon on the screen.
 */
export async function readArt(metadataURI: string): Promise<Art> {
  const url = gatewayUrl(metadataURI);
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return { missing: true };
  }

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), next: { revalidate: 300 } });
    if (!response.ok) {
      return { missing: true };
    }

    const parsed = metadataSchema.safeParse(await response.json());
    if (!parsed.success) {
      return { missing: true };
    }

    const { name, description, prompt } = parsed.data;
    // A few early records carry a sentence where a picture URI belongs. Only a
    // real address becomes an img src; anything else gets the seal plate.
    const image = pictureUri(parsed.data.image);
    const small = pictureUri(parsed.data.thumbnail) ?? image;
    return {
      title: name,
      description,
      prompt,
      imageUrl: image === undefined ? undefined : gatewayUrl(image),
      thumbnailUrl: small === undefined ? undefined : gatewayUrl(small),
      missing: small === undefined,
    };
  } catch {
    return { missing: true };
  }
}

function pictureUri(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return /^(ipfs:\/\/|https?:\/\/)/.test(value) ? value : undefined;
}
