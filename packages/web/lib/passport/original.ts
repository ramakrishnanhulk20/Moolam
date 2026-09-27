import type { Hex } from "viem";
import { gatewayUrl } from "@/lib/chain/client";
import { getPassport } from "@/lib/chain/registry";
import { heldUnseal } from "@/lib/data/unseal";
import { MAX_UPLOAD_BYTES } from "@/lib/upload/checkImage";

/**
 * The registered file behind one passport, found for the download route.
 *
 * Everything here starts from the passport id and nothing else. The chain names
 * the metadata document, the document (or, for a passport published after it
 * was sealed, the unseal record) names the picture, and both are read only as
 * bare IPFS content ids through the configured gateway. A caller can never hand
 * this a content id or an address of their own, so the route cannot be turned
 * into a free proxy for somebody else's files.
 */

/** The same cap the verify service reads a metadata document under. A Moolam document is under 2 KB. */
export const MAX_DOCUMENT_BYTES = 64 * 1024;

/** The largest picture served, which is the largest the verify service ever accepted for registration. */
export const MAX_PICTURE_BYTES = MAX_UPLOAD_BYTES;

const DOCUMENT_TIMEOUT_MS = 8_000;

const PASSPORT_ID = /^0x[0-9a-f]{64}$/;

export type Original =
  | { state: "found"; cid: string; title: string | undefined }
  | { state: "refused"; status: 404 | 502 | 503; message: string };

/** The id in its one lower-case form, or null for anything that is not 32 bytes of hex. */
export function passportIdFrom(value: string): Hex | null {
  const id = value.toLowerCase();
  return PASSPORT_ID.test(id) ? (id as Hex) : null;
}

/**
 * The content id in `ipfs://<cid>`, or null for anything else: an https
 * address, a path under the id, a query, or a sentence. The same rule the
 * verify service and both workflows read documents by.
 */
export function bareContentId(reference: unknown): string | null {
  if (typeof reference !== "string" || !reference.startsWith("ipfs://")) {
    return null;
  }
  const cid = reference.slice("ipfs://".length);
  return /^[A-Za-z0-9]+$/.test(cid) ? cid : null;
}

/** Where one pinned file is read from. The gateway is the only host this module ever asks. */
export function pinnedAddress(cid: string): string {
  return gatewayUrl(`ipfs://${cid}`);
}

/**
 * Which picture a passport's download serves, or why there is none.
 *
 * The registry is read live rather than through the index or a held read, so a
 * picture registered a few seconds ago is found before the index has caught up,
 * and an id that was unknown a moment ago is not remembered as unknown.
 *
 * Throws only when the chain itself will not answer.
 */
export async function findOriginal(id: Hex): Promise<Original> {
  const passport = await getPassport(id);
  if (passport === null) {
    return { state: "refused", status: 404, message: "No passport has this id." };
  }

  const documentCid = bareContentId(passport.metadataURI);
  if (documentCid === null) {
    return {
      state: "refused",
      status: 404,
      message: "This passport's metadata is not a pinned IPFS content id, so Moolam does not read it.",
    };
  }

  const document = await readDocument(documentCid);
  if (document === null) {
    return {
      state: "refused",
      status: 502,
      message: "The IPFS gateway did not hand over this passport's metadata. Try again in a moment.",
    };
  }

  const title = typeof document.name === "string" && document.name.trim() !== "" ? document.name : undefined;

  // A document that names a picture is read as published even when it also
  // says sealed, the same rule every passport page follows: a pinned picture
  // is already public, whatever the words beside it claim.
  if (document.image !== undefined) {
    return pictureFrom(document.image, title);
  }

  if (document.sealed !== true) {
    return { state: "refused", status: 404, message: "This passport's metadata names no picture." };
  }

  const lookup = await heldUnseal(id);
  if (lookup.state === "sealed") {
    return {
      state: "refused",
      status: 404,
      message: "This passport is sealed. Its picture was never published, so there is nothing to download.",
    };
  }
  if (lookup.state === "unknown") {
    return {
      state: "refused",
      status: 503,
      message: "Moolam could not tell whether this sealed passport has been published. Try again in a moment.",
    };
  }
  return pictureFrom(lookup.record.image.uri, title);
}

function pictureFrom(reference: unknown, title: string | undefined): Original {
  const cid = bareContentId(reference);
  return cid === null
    ? {
        state: "refused",
        status: 404,
        message: "This passport's picture is not a pinned IPFS content id, so Moolam does not serve it.",
      }
    : { state: "found", cid, title };
}

/**
 * The metadata document as a plain object, or null when the gateway would not
 * hand over a JSON object under the cap. No redirect is followed, so the
 * gateway cannot send this server anywhere else.
 */
async function readDocument(cid: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(pinnedAddress(cid), {
      signal: AbortSignal.timeout(DOCUMENT_TIMEOUT_MS),
      redirect: "error",
      cache: "no-store",
    });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    const text = await cappedText(response, MAX_DOCUMENT_BYTES);
    if (text === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The body as text, or null past `cap` bytes. A declared length over the cap is
 * refused unread, and otherwise reading stops at the first chunk past it.
 */
async function cappedText(response: Response, cap: number): Promise<string | null> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > cap) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (response.body === null) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    length += value.byteLength;
    if (length > cap) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** The three kinds of picture Moolam registers, told apart by their first bytes rather than by a header. */
export type PictureType = { type: "image/jpeg" | "image/png" | "image/webp"; extension: "jpg" | "png" | "webp" };

/** Enough of a file's start to tell the three apart. */
export const SNIFF_BYTES = 12;

export function pictureType(head: Uint8Array): PictureType | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return { type: "image/jpeg", extension: "jpg" };
  }
  if (head.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, at) => head[at] === byte)) {
    return { type: "image/png", extension: "png" };
  }
  const ascii = (from: number, to: number) => String.fromCharCode(...head.slice(from, to));
  if (head.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") {
    return { type: "image/webp", extension: "webp" };
  }
  return null;
}

/**
 * The name the file is saved under: the title in plain letters, then enough of
 * the passport id to tell two pictures with the same title apart. The same
 * shape the verify service pins under, so the downloaded file and the pinned
 * one read alike. A title with no Latin letters or digits in it, or no title
 * at all, becomes moolam and the id.
 */
export function downloadName(title: string | undefined, id: Hex, extension: string): string {
  const words = (title ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return `${words.length === 0 ? "moolam" : words}-${id.slice(2, 10)}.${extension}`;
}
