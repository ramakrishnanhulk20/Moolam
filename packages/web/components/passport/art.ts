import { z } from "zod";
import { gatewayUrl } from "@/lib/chain/client";
import { pictureSources } from "@/lib/images";

// The content id reader moved next to the gateway list it belongs with. The
// screens that name a link after what it points at still ask for it here.
export { cidOf } from "@/lib/images";

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
 * Reads one passport's metadata, through the account's own gateway first and
 * the public ones behind it.
 *
 * A gateway that is slow, rate limited or missing the document costs the
 * picture, never the page: the last resort is the seal on a dark plate and a
 * sentence rather than a broken image icon on the screen.
 */
export async function readArt(metadataURI: string): Promise<Art> {
  for (const url of pictureSources(metadataURI)) {
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      continue;
    }
    const art = await readFrom(url);
    if (art !== null) {
      return art;
    }
  }
  return { missing: true };
}

/** One gateway's answer, or null when it did not give a document this can read. */
async function readFrom(url: string): Promise<Art | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), next: { revalidate: 300 } });
    if (!response.ok) {
      return null;
    }

    const parsed = metadataSchema.safeParse(await response.json());
    if (!parsed.success) {
      return null;
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
    return null;
  }
}

function pictureUri(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return /^(ipfs:\/\/|https?:\/\/)/.test(value) ? value : undefined;
}
