import { z } from "zod";
import { pinnedContentId, readMetadataDocument, type DocumentReader } from "../unseal.js";

/** The longest title the claims page draws, in code points: the same 120 a platform prepare takes. */
export const MAX_TITLE_CODE_POINTS = 120;

/** A content id longer than this is not one Pinata gives, and is not handed on. */
const MAX_CID_LENGTH = 100;

/** How long one metadata read may take before the offer is shown with no preview. */
export const PREVIEW_READ_MS = 5_000;

/** A content id names fixed bytes, so a preview read once stays right; this bounds the memory it costs. */
const CACHE_MAX = 2_000;

/** A read that failed is tried again after this, so a gateway hiccup does not hide a picture for good. */
const MISS_TTL_MS = 10 * 60 * 1000;

// Letters, marks, digits, punctuation, symbols and the plain space, as the platform list takes a
// name. Shuts out control, format and direction-override characters without a list of them. Does
// not catch look-alike letters from two scripts.
const PRINTABLE_TEXT = /^[\p{L}\p{M}\p{N}\p{P}\p{S} ]+$/u;

const documentSchema = z.object({ name: z.string(), thumbnail: z.string() });

export interface Preview {
  title: string;
  /** "ipfs://<cid>" of the passport's thumbnail, for the page's pinned-picture rule to draw. */
  image: string;
}

export type PreviewReader = (metadataURI: string | null) => Promise<Preview | null>;

/**
 * What a platform's document is allowed to put on the claims page (P36), or null for "no preview".
 *
 * The metadataURI is the platform's choice, so it is read only through the pinned-content rule
 * (readMetadataDocument: a bare ipfs content id, the configured gateway, no redirect, a byte cap).
 * The title is text, NFKC, one line of printable characters, at most 120 code points. The picture
 * is the thumbnail's content id, refused unless it passes the same pinned-content predicate. Any
 * other shape, any failed read, any field out of bounds: null, and the offer still shows its id.
 */
export function previewOf(document: unknown): Preview | null {
  const parsed = documentSchema.safeParse(document);
  if (!parsed.success) return null;
  const title = parsed.data.name.normalize("NFKC").trim();
  const length = [...title].length;
  if (length === 0 || length > MAX_TITLE_CODE_POINTS || !PRINTABLE_TEXT.test(title)) return null;
  const cid = pinnedContentId(parsed.data.thumbnail);
  if (cid === null || cid.length > MAX_CID_LENGTH) return null;
  return { title, image: `ipfs://${cid}` };
}

/** The live preview reader: one gateway read per document, with what it found kept by its address. */
export function previewReader(
  read: DocumentReader = async (uri) => await readMetadataDocument(uri, { timeoutMs: PREVIEW_READ_MS }),
  clock: () => number = Date.now,
): PreviewReader {
  const kept = new Map<string, { preview: Preview | null; at: number }>();
  return async (metadataURI) => {
    if (metadataURI === null || pinnedContentId(metadataURI) === null) return null;
    const held = kept.get(metadataURI);
    if (held !== undefined && (held.preview !== null || clock() - held.at < MISS_TTL_MS)) {
      return held.preview;
    }
    let preview: Preview | null;
    try {
      preview = previewOf(await read(metadataURI));
    } catch {
      preview = null;
    }
    if (kept.size >= CACHE_MAX) {
      const oldest = kept.keys().next().value;
      if (oldest !== undefined) kept.delete(oldest);
    }
    kept.set(metadataURI, { preview, at: clock() });
    return preview;
  };
}

/** No gateway, for a host under a test runner: every offer shows no preview. */
export function offlinePreviewReader(): PreviewReader {
  return async () => null;
}
