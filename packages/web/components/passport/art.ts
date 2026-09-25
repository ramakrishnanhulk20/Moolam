import { z } from "zod";
import { gatewayUrl } from "@/lib/chain/client";
import { PICTURE_HOSTS, pictureSources } from "@/lib/images";

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
  sealed: z.boolean().optional(),
  // Read as anything, so a document that writes the word some other way is not
  // thrown away whole: only the boolean true asks for a private re-check.
  privateRecheck: z.unknown().optional(),
  commitment: z.object({ algorithm: z.string(), value: z.string() }).optional(),
  fingerprint: z.object({ blockhash: z.string().optional() }).optional(),
});

/** A 32 byte word as the sealed document writes it, which is what the sketch is drawn from. */
const BLOCK_HASH = /^0x[0-9a-f]{64}$/;

export interface Art {
  title?: string;
  description?: string;
  prompt?: string;
  /** The full image, for a poster. */
  imageUrl?: string;
  /** The small copy, for a grid. Falls back to the full image when none was pinned. */
  thumbnailUrl?: string;
  /**
   * True when this passport's picture was never published. There is no image
   * and no thumbnail to ask any gateway for, and that is the record as it was
   * registered rather than anything missing.
   */
  sealed?: true;
  /**
   * True when a sealed document asked Moolam to keep one small private copy for
   * a Chainlink re-check. The document says so for ever; whether the copy is
   * still kept is a separate question for the verify service.
   */
  privateRecheck?: true;
  /** How the chain's hold on the sealed file is written down: the algorithm, and the passport id. */
  commitment?: { algorithm: string; value: string };
  /** The 256 bit block hash of a sealed picture, the one trace of it anybody outside the creator sees. */
  blockhash?: string;
  /**
   * Set when this passport was registered sealed and its holder published the
   * picture later. The pinned document still says sealed, because the chain
   * points at it for ever and it can never be rewritten; the record named here
   * is what says the picture is out, and when, and who opened it.
   */
  unsealed?: {
    /** ISO 8601, as the record was written. */
    at: string;
    /** The wallet the registry said held the passport at that moment. */
    by: string;
    record: { cid: string; uri: string };
  };
  /** True when the gateway did not answer or the document was not readable. */
  missing: boolean;
}

const TIMEOUT_MS = 8_000;

/**
 * Documents that said sealed and still named a picture, so the line about each
 * one is written once rather than on every read of the same record.
 *
 * The verify service's schema has no room for such a document, so one appearing
 * means something wrote a record this reader disagrees with. The picture wins:
 * it is pinned, so it is already public, and hiding a published picture behind
 * a seal would tell a creator something about their own record that is not true.
 */
const contradicted = new Set<string>();

function noteContradiction(url: string): void {
  if (contradicted.has(url)) {
    return;
  }
  // Bounded, because a set that grows on an error path is a leak nobody watches.
  if (contradicted.size >= 200) {
    contradicted.clear();
  }
  contradicted.add(url);
  console.log(`moolam: this document says sealed and still names a picture, so it is read as published: ${url}`);
}

/**
 * Reads one passport's metadata, through the account's own gateway first and
 * the public ones behind it.
 *
 * A gateway that is slow, rate limited or missing the document costs the
 * picture, never the page: the last resort is the seal on a dark plate and a
 * sentence rather than a broken image icon on the screen.
 *
 * Only a pinned document is read. The registry takes any string as the
 * document address, so one written straight to the chain could name a host
 * of the registrant's choosing, and this server would fetch from it.
 */
export async function readArt(metadataURI: string): Promise<Art> {
  const pinned = pinnedUri(metadataURI);
  if (pinned === undefined) {
    return { missing: true };
  }
  for (const url of pictureSources(pinned)) {
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

    const document: unknown = await response.json();
    const parsed = metadataSchema.safeParse(document);
    if (!parsed.success) {
      return null;
    }

    const { name, description, prompt } = parsed.data;
    // Only a pinned address becomes an img src; anything else gets the seal plate.
    const image = pictureUri(parsed.data.image);
    const small = pictureUri(parsed.data.thumbnail) ?? image;

    const claimsSealed = parsed.data.sealed === true;
    const sealed = claimsSealed && small === undefined;
    if (claimsSealed && !sealed) {
      noteContradiction(url);
    }

    const blockhash = parsed.data.fingerprint?.blockhash;

    return {
      title: name,
      description,
      prompt,
      imageUrl: image === undefined ? undefined : gatewayUrl(image),
      thumbnailUrl: small === undefined ? undefined : gatewayUrl(small),
      ...(sealed
        ? {
            sealed: true as const,
            commitment: parsed.data.commitment,
            blockhash: blockhash !== undefined && BLOCK_HASH.test(blockhash) ? blockhash : undefined,
            ...(asksPrivateRecheck(document) ? { privateRecheck: true as const } : {}),
          }
        : {}),
      // A sealed record is not missing anything. It has no picture because its
      // creator chose that, which is the one state this flag must never blame
      // on a gateway.
      missing: !sealed && small === undefined,
    };
  } catch {
    return null;
  }
}

/**
 * The same rule the verify service, the queue, the runner and the sealed
 * workflow all use: sealed and privateRecheck are the boolean true, and the
 * document has neither an image nor a thumbnail key, whatever their values.
 */
function asksPrivateRecheck(document: unknown): boolean {
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return false;
  }
  const fields = document as Record<string, unknown>;
  return (
    fields.sealed === true &&
    fields.privateRecheck === true &&
    !Object.hasOwn(fields, "image") &&
    !Object.hasOwn(fields, "thumbnail")
  );
}

/**
 * A picture address the screens may draw, as ipfs://<cid>, or nothing.
 *
 * Only IPFS is accepted, and it is always read back through Moolam's own
 * gateway. A document registered straight on chain can name any address it
 * likes; drawn as it stands, an https one would send every visitor's browser
 * to a host the registrant chose, which could log them and swap the picture
 * after the fact. Anything else gets the seal plate, as the film already does
 * (components/story/data.ts).
 *
 * A few early records carry a sentence where a picture address belongs, and
 * those get the seal plate too.
 */
function pictureUri(value: string | undefined): string | undefined {
  return value === undefined ? undefined : pinnedUri(value);
}

const PINNED = /^ipfs:\/\/([A-Za-z0-9]+)((?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*)$/;
const ON_GATEWAY = /^\/ipfs\/([A-Za-z0-9]+)((?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*)\/?$/;

/**
 * ipfs://<cid>, or the same file named on Moolam's own gateway, which is the
 * one https form Moolam itself writes. Both come back as ipfs://<cid>, so the
 * caller resolves them through the gateway this deploy is set to. Any other
 * host, scheme or shape is undefined.
 */
export function pinnedUri(value: string): string | undefined {
  const direct = PINNED.exec(value);
  if (direct !== null) {
    return value;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || !PICTURE_HOSTS.includes(url.hostname) || url.search !== "" || url.hash !== "") {
    return undefined;
  }
  const onGateway = ON_GATEWAY.exec(url.pathname);
  return onGateway === null ? undefined : `ipfs://${onGateway[1]}${onGateway[2]}`;
}
