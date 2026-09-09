import { z } from "zod";

/**
 * The pinned metadata JSON, read back for the creator's own list of passports.
 *
 * Only the two fields a thumbnail needs are described. Anything else in the
 * document is left alone, so a metadata file written by a later version still
 * renders instead of failing a strict shape check.
 */
const metadataSchema = z.object({
  name: z.string().optional(),
  image: z.string().optional(),
  thumbnail: z.string().optional(),
});

export interface PassportArt {
  title?: string;
  /** An ipfs:// or http URI. The caller runs it through gatewayUrl before rendering. */
  uri?: string;
}

/**
 * The picture to show for a passport, preferring the thumbnail the verifier
 * pinned. Returns nothing at all rather than a broken image when the document
 * is not what this app writes.
 */
export function passportArt(metadata: unknown): PassportArt {
  const parsed = metadataSchema.safeParse(metadata);
  if (!parsed.success) {
    return {};
  }

  const uri = parsed.data.thumbnail ?? parsed.data.image;
  return {
    title: parsed.data.name,
    uri: typeof uri === "string" && uri.length > 0 ? uri : undefined,
  };
}
