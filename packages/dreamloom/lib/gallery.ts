import { z } from "zod";

/** One picture in the gallery, everything the browser needs and nothing it should not see. */
export interface GalleryPicture {
  passportId: string;
  /** The small copy through the IPFS gateway, or null when none could be read or none was published. */
  imageUrl: string | null;
  /** True when the picture's document was read and names no picture: its creator kept it private. */
  unpublished: boolean;
  /** The words the picture was drawn from, when its document names them. */
  prompt: string | null;
  title: string | null;
  registeredAt: number;
  passportUrl: string;
}

export type GalleryAnswer =
  { state: "ready"; pictures: GalleryPicture[]; readAt: number } | { state: "unavailable"; readAt: number };

export interface GallerySettings {
  indexUrl: string | undefined;
  agentId: string | undefined;
  siteUrl: string;
  gateway: string;
  send?: typeof fetch;
  now?: () => number;
  holdMs?: number;
}

export const GALLERY_SIZE = 24;
export const HOLD_MS = 60_000;
const INDEX_TIMEOUT_MS = 10_000;
const DOCUMENT_TIMEOUT_MS = 8_000;
const DOCUMENT_READS_AT_ONCE = 6;

const PASSPORT_ID = /^0x[0-9a-f]{64}$/;
const AGENT_ID = /^[0-9]{1,78}$/;
const PINNED = /^ipfs:\/\/([A-Za-z0-9]{10,})((?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*)$/;

const QUERY = `query DreamloomGallery($generator: String!, $limit: Int!) {
  Passport(where: { generator_id: { _eq: $generator } }, order_by: [{ registeredAt: desc }, { id: desc }], limit: $limit) {
    id
    registeredAt
    metadataURI
  }
}`;

const indexAnswer = z.object({
  data: z.object({
    Passport: z.array(
      z.object({
        id: z.string(),
        registeredAt: z.union([z.string(), z.number()]),
        metadataURI: z.string(),
      }),
    ),
  }),
});

const documentShape = z.object({
  name: z.string().optional(),
  prompt: z.string().optional(),
  image: z.string().optional(),
  thumbnail: z.string().optional(),
});

/**
 * The passport page for one passport on Moolam's site, in English. Only a
 * well-formed passport id becomes a link, so nothing the index sends can turn
 * a badge into a link somewhere else.
 */
export function passportUrl(passportId: string, siteUrl: string, locale = "en"): string {
  const id = passportId.toLowerCase();
  if (!PASSPORT_ID.test(id)) {
    throw new Error("not a passport id");
  }
  return `${siteUrl.replace(/\/+$/, "")}/${locale}/passport/${id}`;
}

/**
 * The gateway address of a file its document names as ipfs://<cid>. Any other
 * address is refused, because a document written straight to the chain can
 * name any host it likes and every visitor's browser would then ask that host.
 */
export function gatewayAddress(uri: string | undefined, gateway: string): string | null {
  if (uri === undefined || !PINNED.test(uri)) {
    return null;
  }
  const base = gateway.endsWith("/") ? gateway : `${gateway}/`;
  return `${base}${uri.slice("ipfs://".length)}`;
}

/**
 * A reader for the gallery that asks Moolam's index at most once a minute
 * however many visitors arrive. Callers that come while a read is in flight
 * share it, and a failed read is held for the same minute, because the index's
 * allowance is shared with Moolam's live site and a retry loop here would spend
 * it for everyone.
 */
export function createGalleryReader(settings: GallerySettings) {
  const send = settings.send ?? fetch;
  const now = settings.now ?? Date.now;
  const holdMs = settings.holdMs ?? HOLD_MS;
  // A pinned document never changes, so each one is read once for the life of the server.
  const documents = new Map<string, z.infer<typeof documentShape>>();

  let held: GalleryAnswer | null = null;
  let inFlight: Promise<GalleryAnswer> | null = null;

  async function readDocument(uri: string) {
    const known = documents.get(uri);
    if (known !== undefined) {
      return known;
    }
    const address = gatewayAddress(uri, settings.gateway);
    if (address === null) {
      return null;
    }
    try {
      const response = await send(address, { signal: AbortSignal.timeout(DOCUMENT_TIMEOUT_MS), cache: "no-store" });
      if (!response.ok) {
        return null;
      }
      const parsed = documentShape.safeParse(await response.json());
      if (!parsed.success) {
        return null;
      }
      if (documents.size >= 500) {
        documents.clear();
      }
      documents.set(uri, parsed.data);
      return parsed.data;
    } catch {
      return null;
    }
  }

  async function readIndex(): Promise<GalleryAnswer> {
    const readAt = now();
    const { indexUrl, agentId } = settings;
    if (indexUrl === undefined || indexUrl === "" || agentId === undefined || !AGENT_ID.test(agentId)) {
      return { state: "unavailable", readAt };
    }

    let rows: z.infer<typeof indexAnswer>["data"]["Passport"];
    try {
      const response = await send(indexUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: QUERY, variables: { generator: agentId, limit: GALLERY_SIZE } }),
        signal: AbortSignal.timeout(INDEX_TIMEOUT_MS),
        cache: "no-store",
      });
      if (!response.ok) {
        return { state: "unavailable", readAt };
      }
      const parsed = indexAnswer.safeParse(await response.json());
      if (!parsed.success) {
        return { state: "unavailable", readAt };
      }
      rows = parsed.data.data.Passport;
    } catch {
      return { state: "unavailable", readAt };
    }

    const wellFormed = rows.filter((row) => PASSPORT_ID.test(row.id.toLowerCase()));
    const pictures: GalleryPicture[] = new Array(wellFormed.length);
    let next = 0;
    async function worker() {
      while (next < wellFormed.length) {
        const at = next++;
        const row = wellFormed[at];
        const document = await readDocument(row.metadataURI);
        const imageUrl = gatewayAddress(document?.thumbnail ?? document?.image, settings.gateway);
        pictures[at] = {
          passportId: row.id.toLowerCase(),
          imageUrl,
          unpublished: document !== null && imageUrl === null,
          prompt: document?.prompt?.trim() || null,
          title: document?.name?.trim() || null,
          registeredAt: Number(row.registeredAt),
          passportUrl: passportUrl(row.id, settings.siteUrl),
        };
      }
    }
    await Promise.all(Array.from({ length: DOCUMENT_READS_AT_ONCE }, worker));
    return { state: "ready", pictures, readAt };
  }

  return async function readGallery(): Promise<GalleryAnswer> {
    if (held !== null && now() - held.readAt < holdMs) {
      return held;
    }
    if (inFlight === null) {
      inFlight = readIndex()
        .then((answer) => {
          held = answer;
          return answer;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return await inFlight;
  };
}

/**
 * Moolam's own IPFS gateway, where every passport's pictures are pinned. The
 * public Pinata gateway answered 429 for most thumbnails on 30 September, so it
 * cannot carry a gallery of 24 pictures.
 */
const MOOLAM_GATEWAY = "https://lavender-personal-grasshopper-978.mypinata.cloud/ipfs/";

let shared: (() => Promise<GalleryAnswer>) | null = null;

/** The one reader this server uses, set from the environment on first use. */
export async function readGallery(): Promise<GalleryAnswer> {
  shared ??= createGalleryReader({
    indexUrl: process.env.MOOLAM_INDEX_URL,
    agentId: process.env.DREAMLOOM_AGENT_ID,
    siteUrl: process.env.MOOLAM_SITE_URL || "https://moolam.site",
    gateway: process.env.MOOLAM_IPFS_GATEWAY || MOOLAM_GATEWAY,
  });
  return await shared();
}
