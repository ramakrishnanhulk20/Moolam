import { createHash } from "node:crypto";
import { contentIdOf, pinFile } from "../ipfs/pinata.js";
import { safeReason } from "../net/errorText.js";
import { refusedByPinata } from "../sealed.js";

/** The four files every platform passport pins, in the order their ids depend on each other. */
export const FILE_ROLES = ["image", "thumbnail", "manifest", "metadata"] as const;

export type FileRole = (typeof FILE_ROLES)[number];

export type FileType = "image/jpeg" | "application/json";

/** One file of a passport as it will be pinned: its name, its type and the ids computed here. */
export interface FileEntry {
  name: string;
  contentType: FileType;
  /** The content id Pinata will give these bytes, computed by contentIdOf before anything is sent. */
  cid: string;
  sha256: string;
  bytes: number;
}

export interface FileSet {
  entries: Record<FileRole, FileEntry>;
  bytes: Record<FileRole, Buffer>;
}

/**
 * A JSON document as the bytes that get pinned: the same two-space text and closing newline pinJson
 * writes, so a document built here and one pinned by /prepare are laid out alike.
 */
export function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function fileEntry(name: string, contentType: FileType, bytes: Buffer): FileEntry {
  return {
    name,
    contentType,
    cid: contentIdOf(bytes),
    sha256: `0x${createHash("sha256").update(bytes).digest("hex")}`,
    bytes: bytes.length,
  };
}

/** The ipfs:// address of one file, from the id computed here. */
export function ipfsUri(entry: FileEntry): `ipfs://${string}` {
  return `ipfs://${entry.cid}`;
}

/**
 * Every file a passport needs, with each content id computed before anything is pinned (P6). The
 * metadata document names the other three by the ids computed here, and its own bytes are fixed
 * now, so what is pinned later is exactly what the passport's metadataURI commits to.
 */
export function buildFileSet(input: {
  slug: string;
  image: Buffer;
  thumbnail: Buffer;
  manifestDoc: unknown;
  metadata: (uris: { image: string; thumbnail: string; manifest: string }) => unknown;
}): FileSet {
  const manifestBytes = jsonBytes(input.manifestDoc);
  const image = fileEntry(`${input.slug}.jpg`, "image/jpeg", input.image);
  const thumbnail = fileEntry(`${input.slug}-thumb.jpg`, "image/jpeg", input.thumbnail);
  const manifest = fileEntry(`${input.slug}-c2pa.json`, "application/json", manifestBytes);
  const metadataBytes = jsonBytes(
    input.metadata({ image: ipfsUri(image), thumbnail: ipfsUri(thumbnail), manifest: ipfsUri(manifest) }),
  );
  const metadata = fileEntry(`${input.slug}.json`, "application/json", metadataBytes);
  return {
    entries: { image, thumbnail, manifest, metadata },
    bytes: { image: input.image, thumbnail: input.thumbnail, manifest: manifestBytes, metadata: metadataBytes },
  };
}

export type PinOutcome = { ok: true } | { ok: false; landed: boolean; reason: string };

/**
 * Pins a file set, sending cid_version v1 so a change of Pinata's default fails loudly, and checks
 * every id Pinata answers with against the one computed before (P6). The picture, its thumbnail and
 * the manifest document go at once; the metadata goes last, so a metadata document is never pinned
 * naming a file that failed.
 *
 * Never throws. `landed` says whether Pinata may now hold any of the files because of this call,
 * which decides whether a daily slot stays spent.
 */
export async function pinFileSet(set: FileSet): Promise<PinOutcome> {
  const pinOne = async (role: FileRole): Promise<void> => {
    const entry = set.entries[role];
    const pinned = await pinFile(set.bytes[role], entry.name, entry.contentType, { cidVersion: "v1" });
    // pinFile already refuses an answer naming another id; this repeats the check against the id
    // the passport was built on, so a change inside pinFile cannot quietly loosen it.
    if (pinned.cid !== entry.cid) {
      throw new Error(`Pinata answered ${role} with ${pinned.cid}, and the passport names ${entry.cid}`);
    }
  };

  const first = await Promise.allSettled([pinOne("image"), pinOne("thumbnail"), pinOne("manifest")]);
  const landed = (one: PromiseSettledResult<void>): boolean => one.status === "fulfilled" || !refusedByPinata(one.reason);
  const failed = first.filter((one): one is PromiseRejectedResult => one.status === "rejected");
  if (failed.length > 0) {
    return { ok: false, landed: first.some(landed), reason: failed.map((one) => safeReason(one.reason)).join("; ") };
  }
  try {
    await pinOne("metadata");
  } catch (error) {
    return { ok: false, landed: true, reason: safeReason(error) };
  }
  return { ok: true };
}
