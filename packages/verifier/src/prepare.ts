import sharp from "sharp";
import { SignerRefusedFile, SignerUnavailable, embedManifest, readManifest, type ManifestSummary } from "./c2pa.js";
import { trainingAssertion, type TrainingConsent } from "./consent.js";
import {
  MAX_IMAGE_PIXELS,
  PHASH_MATCH_THRESHOLD,
  fingerprint,
  flattenedOntoWhite,
  hamming64,
  phashOf,
  readImageHeader,
  type Fingerprint,
  type Hex,
} from "./fingerprint.js";
import { manifestDocument } from "./metadata.js";

export type { Fingerprint, ManifestSummary };

/**
 * The Chainlink verifier downloads this thumbnail inside a sandbox with a 100 KB fetch cap, so
 * the file has to stay well under that with room for gateway overhead.
 */
export const THUMBNAIL_MAX_BYTES = 60_000;

/**
 * What a caller is told when a picture's thumbnail will not fit the budget above. Both routes
 * answer under the one code thumbnail-too-large, and each sentence names what the caller was
 * trying to do: a public registration, which a sealed one can still replace, a sealed one with a
 * private re-check, which a plain sealed one can still replace, or an unseal.
 */
export const THUMBNAIL_TOO_LARGE_REASON =
  "this picture cannot be reduced to a thumbnail small enough for the Chainlink verifier to fetch, so a public passport for it could never be re-checked. Registering it sealed makes no thumbnail and still works. Nothing was pinned.";

export const PRIVATE_RECHECK_THUMBNAIL_TOO_LARGE_REASON =
  "this picture cannot be reduced to a thumbnail small enough for the Chainlink verifier to fetch, so a private re-check could never open it. Registering it sealed without the private re-check makes no thumbnail and still works. Nothing was pinned.";

export const EDIT_THUMBNAIL_TOO_LARGE_REASON =
  "this picture cannot be reduced to a thumbnail small enough for the Chainlink verifier to fetch, so an edit made from it could never be re-checked. Nothing was pinned and nothing was sent.";

export const UNSEAL_THUMBNAIL_TOO_LARGE_REASON =
  "this picture cannot be reduced to a thumbnail small enough for the Chainlink verifier to fetch, so unsealing it would publish a passport that can never be re-checked. Nothing was pinned.";

/**
 * The picture decoded and resized, and its thumbnail is still over THUMBNAIL_MAX_BYTES at the
 * lowest quality tried. It is its own class so a route can tell it from a file that would not
 * decode at all: this one is a real picture with too much detail, and the caller deserves to know.
 */
export class ThumbnailTooLarge extends Error {
  readonly limit = THUMBNAIL_MAX_BYTES;
  constructor(message: string) {
    super(message);
    this.name = "ThumbnailTooLarge";
  }
}

/**
 * What a creator is told when signing grew their file past the upload cap every other route holds
 * to. The registered file has to come back through /verify and /unseal byte for byte, and both
 * refuse anything over the cap.
 */
export const SIGNED_FILE_TOO_LARGE_REASON =
  "signing this picture made the file larger than the 20 MB every Moolam route accepts, so its passport could never be checked or unsealed with the registered file. A slightly smaller copy of the picture will register. Nothing was pinned.";

/**
 * What a creator is told when a picture's fingerprint does not survive its own thumbnail. The
 * sentence names the cause a person can see, a picture that only changes from top to bottom, such
 * as a clear sky over a flat horizon, rather than the DCT block that makes it so.
 */
export const FINGERPRINT_UNSTABLE_REASON =
  "this picture has too little detail across its width for a fingerprint that survives copying: its own small copy already reads as a different picture, so the Chainlink re-check and any search for its copies would miss it. A picture with more detail from side to side will register. Nothing was pinned.";

/**
 * The picture's pHash and the pHash of its own thumbnail are further apart than the match
 * threshold, so the re-check would call the registered thumbnail a mismatch and an honest copy of
 * the picture could not be matched either (review pass 5, intake 1).
 */
export class FingerprintUnstable extends Error {
  readonly limit = PHASH_MATCH_THRESHOLD;
  readonly distance: number;
  constructor(distance: number) {
    super(
      `the thumbnail's pHash is ${distance} of 64 bits from the picture's, over the ${PHASH_MATCH_THRESHOLD} bit threshold`,
    );
    this.name = "FingerprintUnstable";
    this.distance = distance;
  }
}

/** Longest side of the thumbnail in pixels. Small enough to decode fast, large enough to hash. */
export const THUMBNAIL_LONGEST_SIDE = 512;

/**
 * Quality for the baseline JPEG every upload is normalised to before signing. High enough that one
 * re-encode of a creator's PNG is invisible next to the JPEG the studio would have pinned anyway.
 */
const NORMALISED_QUALITY = 95;

const QUALITY_START = 85;
const QUALITY_FLOOR = 30;
const QUALITY_STEP = 5;

export interface PreparedImage {
  original: Buffer;
  thumbnail: Buffer;
  fingerprint: Fingerprint;
  manifestHash: Hex;
  manifest: ManifestSummary;
}

/** A passport with no manifest commits to no manifest store, so the chain records 32 zero bytes. */
const ZERO_BYTES32 = `0x${"00".repeat(32)}` as Hex;

/**
 * What a caller may tell the person who uploaded the picture when the manifest is missing.
 *
 * It is a fixed sentence rather than the signer's own words on purpose: those words can carry the
 * path of the certificate this host signs with, and no answer from a public route should.
 */
export const NOT_EMBEDDED_REASON = "the manifest could not be embedded in this file";

export interface PreparedResult {
  /** The bytes that get pinned, and whose sha256 becomes the passport id. */
  bytes: Buffer;
  thumbnail: Buffer;
  print: Fingerprint;
  manifestHash: Hex;
  manifestDoc?: unknown;
  embedded: boolean;
  /** Only when the manifest is missing, and always the fixed sentence above. */
  reason?: string;
  /**
   * What the signer actually said, for the log line at the call site. It never goes in an answer:
   * it can name a file path on this host.
   */
  detail?: string;
}

/**
 * The same result for a sealed registration, without the two things a sealed passport does not
 * pin. They are missing from the type rather than left unused, so a later convenience cannot pin
 * a thumbnail of a picture the creator asked us not to publish: there is nothing to pin.
 */
export type SealedResult = Omit<PreparedResult, "thumbnail" | "manifestDoc">;

export interface PrepareOptions {
  title: string;
  claimGenerator: string;
  /**
   * "c2pa.created" only for a picture Moolam's own agent made. An upload is "c2pa.opened" and an
   * edit "c2pa.edited", and neither states a source type: Moolam saw the file, not how it was made.
   */
  action: "c2pa.created" | "c2pa.opened" | "c2pa.edited";
  /** Only with "c2pa.created"; embedManifest refuses it on any other action. */
  digitalSourceType?: string;
  /** What the creator said about AI use, written into the manifest. Left out means they said nothing. */
  training?: TrainingConsent;
}

/**
 * Turns a raw image into everything a passport needs: the C2PA signed JPEG that gets registered,
 * a small baseline thumbnail the Chainlink verifier can fetch and decode, the fingerprint of the
 * signed bytes, and the hash of the manifest store the chain commits to.
 *
 * Whatever the creator brought, JPEG or PNG or WebP, becomes one upright baseline JPEG before
 * anything is signed, and the rotation an EXIF tag asks for is baked into the pixels there. The
 * registered file, its fingerprint, the thumbnail and the hash Chainlink recomputes then all
 * describe one picture, in one container, the same way up.
 *
 * The soft binding written into the manifest is the fingerprint of the source pixels, and the
 * function refuses to continue if signing moved the perceptual hash, because a manifest that
 * describes a different picture than the one being registered is worse than no manifest.
 *
 * Throws when the buffer is empty, when the C2PA library will not sign the container, when the
 * signed file carries no readable manifest, and ThumbnailTooLarge when no thumbnail small enough
 * can be produced.
 */
export async function prepareImage(source: Buffer, opts: PrepareOptions): Promise<PreparedImage> {
  const signed = await signImage(source, opts);
  return { ...signed, thumbnail: await makeThumbnail(signed.original) };
}

/**
 * The signing half of prepareImage: the upright JPEG with the manifest in it, its fingerprint and
 * the hash of the manifest store, and no thumbnail.
 *
 * It is separate so a sealed registration can stop here. Everything the chain commits to is in
 * this result; the thumbnail exists only for the Chainlink verifier to fetch from IPFS, which is
 * not something a sealed passport has.
 *
 * Throws exactly what prepareImage throws, minus the thumbnail's own failure.
 */
async function signImage(source: Buffer, opts: PrepareOptions): Promise<Omit<PreparedImage, "thumbnail">> {
  if (source.length === 0) {
    throw new Error("prepareImage needs a non-empty image buffer.");
  }

  const format = (await readImageHeader(source)).format;
  const upright = await uprightImage(source);
  const sourcePrint = await fingerprint(upright);
  const signed = await embedManifest(upright, {
    title: opts.title,
    claimGenerator: opts.claimGenerator,
    action: opts.action,
    softBinding: { phash: sourcePrint.phash, blockhash: sourcePrint.blockhash },
    digitalSourceType: opts.digitalSourceType,
    training: opts.training,
  });

  const signedPrint = await fingerprint(signed);
  if (signedPrint.phash !== sourcePrint.phash) {
    throw new Error(
      `Signing changed the perceptual hash of this ${format} upload, so the soft binding would describe other pixels.`,
    );
  }

  const manifest = await readManifest(signed);
  if (!manifest.present || manifest.manifestHash === undefined) {
    throw new Error(`The signed JPEG made from this ${format} upload carries no manifest this reader can find.`);
  }
  if (manifest.softBinding === undefined) {
    throw new Error(
      `The manifest signed into this ${format} upload lost its soft binding, so a re-encoded copy could never be matched.`,
    );
  }

  return {
    original: signed,
    fingerprint: signedPrint,
    manifestHash: manifest.manifestHash,
    manifest,
  };
}

/**
 * Prepares a picture for pinning, with the manifest when the signer takes the file and without it
 * when the signer will not.
 *
 * A file this one C2PA signer refuses should not cost the creator their upload: the fingerprint
 * and the on-chain record work with no manifest at all, they just lose the provenance that travels
 * inside the file, and the answer says which of the two happened.
 *
 * A host that cannot sign anything is the opposite case and is not softened here: SignerUnavailable
 * comes straight back out, so the service refuses instead of handing every caller an unsigned
 * picture and a 200.
 *
 * A training statement this service may not write is the same kind of case and is checked before
 * anything is prepared: the fallback would pin the picture with the statement quietly dropped, and
 * a creator's "not allowed" going missing is worse than their upload failing.
 */
export async function prepareOrFallback(source: Buffer, options: PrepareOptions): Promise<PreparedResult> {
  trainingAssertion(options.training);

  try {
    const prepared = await prepareImage(source, options);
    return {
      bytes: prepared.original,
      thumbnail: prepared.thumbnail,
      print: prepared.fingerprint,
      manifestHash: prepared.manifestHash,
      manifestDoc: manifestDocument(prepared),
      embedded: true,
    };
  } catch (error) {
    const refused = refusalOrThrow(error);
    const upright = await uprightImage(source);
    return {
      bytes: upright,
      thumbnail: await makeThumbnail(upright),
      print: await fingerprint(upright),
      manifestHash: ZERO_BYTES32,
      embedded: false,
      reason: NOT_EMBEDDED_REASON,
      detail: refused.message.slice(0, 200),
    };
  }
}

/**
 * The same preparation for a picture the creator is registering without publishing it.
 *
 * The signing, the fingerprint and the fallback are identical to prepareOrFallback, so a sealed
 * passport commits to exactly what a public one would. What is missing is the thumbnail and the
 * readable manifest document: both exist only to be pinned, and a sealed registration pins
 * neither. Nothing derived from the picture is produced that nobody is going to use.
 *
 * One behaviour differs and it differs in the creator's favour: a picture whose thumbnail cannot
 * be squeezed under the Chainlink fetch budget fails a public prepare and passes a sealed one,
 * because that budget is about a file a sealed passport never publishes.
 *
 * Throws what prepareOrFallback throws: SignerUnavailable when this host can sign nothing at all,
 * and a training statement this service may not write stops the picture before anything is signed.
 */
export async function prepareSealed(source: Buffer, options: PrepareOptions): Promise<SealedResult> {
  trainingAssertion(options.training);

  try {
    const signed = await signImage(source, options);
    return {
      bytes: signed.original,
      print: signed.fingerprint,
      manifestHash: signed.manifestHash,
      embedded: true,
    };
  } catch (error) {
    const refused = refusalOrThrow(error);
    const upright = await uprightImage(source);
    return {
      bytes: upright,
      print: await fingerprint(upright),
      manifestHash: ZERO_BYTES32,
      embedded: false,
      reason: NOT_EMBEDDED_REASON,
      detail: refused.message.slice(0, 200),
    };
  }
}

/**
 * Turns a failure from the signing path into the refusal a caller may fall back on, or lets it
 * out when falling back cannot help: a host that cannot sign at all, and a thumbnail over the
 * budget, which the unsigned fallback would make from the very same pixels.
 */
function refusalOrThrow(error: unknown): SignerRefusedFile {
  if (error instanceof SignerUnavailable || error instanceof ThumbnailTooLarge) {
    throw error;
  }
  return error instanceof SignerRefusedFile
    ? error
    : new SignerRefusedFile(error instanceof Error ? error.message : String(error), { cause: error });
}

/**
 * Turns whatever the creator uploaded into one upright baseline JPEG.
 *
 * Two problems are solved by the same re-encode. First, orientation: a phone photo taken sideways
 * stores its pixels rotated and leaves a tag saying which way up it goes, and readers that ignore
 * the tag, including the Chainlink sandbox decoder, would hash a different picture from the one the
 * creator saw. Baking the rotation in removes the argument.
 *
 * Second, the container. The C2PA library will sign a PNG or a WebP, but the manifest store it
 * writes into those containers is not one this service can pull back out and hash, so a PNG upload
 * used to lose its manifest at the last step and get pinned unsigned. Everything downstream expects
 * a JPEG anyway: the pinned file is named .jpg and served as image/jpeg, and the sandbox decoder
 * reads baseline JPEG only. Converting here means the pinned bytes, the manifest, the fingerprints
 * and the thumbnail all describe one file.
 *
 * A JPEG that is already upright and already baseline is not re-encoded, because that would cost
 * image quality for no gain. It loses its EXIF, XMP and IPTC segments instead, byte for byte, so
 * the file pinned to public IPFS for good carries no camera location or serial whatever format it
 * arrived in: the re-encode below drops them too (review pass 5, intake 6).
 *
 * Transparency is flattened onto white, since a JPEG has no alpha channel to carry it, by the same
 * flatten fingerprint() and the eight variants apply to a query.
 */
export async function uprightImage(source: Buffer): Promise<Buffer> {
  const header = await readImageHeader(source);
  if (header.format === "jpeg" && header.orientation === 1 && !(await isProgressive(source))) {
    const stripped = withoutCameraMetadata(source);
    if (stripped !== null) {
      return stripped;
    }
  }

  return await flattenedOntoWhite(sharp(source, { limitInputPixels: MAX_IMAGE_PIXELS }).rotate())
    .jpeg({ quality: NORMALISED_QUALITY, progressive: false })
    .toBuffer();
}

/** APP1 carries EXIF and XMP, APP13 carries IPTC. Nothing else in a JPEG names a place or a camera. */
const CAMERA_METADATA_MARKERS = new Set([0xe1, 0xed]);

/**
 * The same JPEG without its APP1 and APP13 segments, every other byte kept in order: the JFIF
 * header, the colour profile, the Adobe transform marker, any C2PA store in APP11, the tables and
 * the compressed scans. No pixel is decoded or re-encoded.
 *
 * The file is the caller's, so every length is checked against the buffer. Anything this walk does
 * not recognise before the first scan returns null, and the caller re-encodes instead, which drops
 * the metadata too: a malformed header costs quality, never a leaked location.
 */
export function withoutCameraMetadata(jpeg: Buffer): Buffer | null {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
    return null;
  }
  const kept: Buffer[] = [jpeg.subarray(0, 2)];
  let offset = 2;
  while (offset + 4 <= jpeg.length) {
    if (jpeg[offset] !== 0xff) {
      return null;
    }
    const marker = jpeg[offset + 1] as number;
    // Fill bytes before a marker, and the standalone markers, carry no length.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      return null;
    }
    if (marker === 0xda) {
      kept.push(jpeg.subarray(offset));
      return Buffer.concat(kept);
    }
    const end = offset + 2 + jpeg.readUInt16BE(offset + 2);
    if (end - offset < 4 || end > jpeg.length) {
      return null;
    }
    if (!CAMERA_METADATA_MARKERS.has(marker)) {
      kept.push(jpeg.subarray(offset, end));
    }
    offset = end;
  }
  return null;
}

/**
 * True for a JPEG stored in progressive scans. The Chainlink sandbox decodes with jpeg-js, which
 * reads baseline files only, so a progressive upload has to be re-encoded rather than passed on.
 */
async function isProgressive(source: Buffer): Promise<boolean> {
  const metadata = await sharp(source, { limitInputPixels: MAX_IMAGE_PIXELS }).metadata();
  return metadata.isProgressive === true;
}

/**
 * Shrinks the image until it fits the verifier's fetch budget.
 *
 * The output is a baseline JPEG on purpose: the Chainlink sandbox decodes with jpeg-js, which
 * reads baseline files only, so a progressive thumbnail would fail every verification.
 *
 * `maxBytes` is smaller than THUMBNAIL_MAX_BYTES only for a private copy, which gains a comment
 * after this and still has to fit the fetch budget (review pass 5, intake 5).
 *
 * Throws ThumbnailTooLarge when even the lowest quality is over the budget, and whatever sharp
 * throws for pixels it cannot decode.
 */
export async function makeThumbnail(image: Buffer, maxBytes: number = THUMBNAIL_MAX_BYTES): Promise<Buffer> {
  const budget = Math.min(maxBytes, THUMBNAIL_MAX_BYTES);
  const shrunk = await shrinkToBudget(image, budget);
  if (!shrunk.fits) {
    throw new ThumbnailTooLarge(
      `The thumbnail is still ${shrunk.thumbnail.length} bytes at quality ${QUALITY_FLOOR}, over the ${budget} byte cap.`,
    );
  }
  return shrunk.thumbnail;
}

/**
 * The first quality at or under the budget, or the lowest quality tried when none fits. Every
 * candidate is a baseline JPEG of the same resized pixels, so the one kept is exactly what
 * makeThumbnail would hand the workflow.
 */
async function shrinkToBudget(image: Buffer, maxBytes: number): Promise<{ thumbnail: Buffer; fits: boolean }> {
  const resized = sharp(image, { limitInputPixels: MAX_IMAGE_PIXELS }).resize({
    width: THUMBNAIL_LONGEST_SIDE,
    height: THUMBNAIL_LONGEST_SIDE,
    fit: "inside",
    withoutEnlargement: true,
  });

  let last: Buffer | undefined;
  for (let quality = QUALITY_START; quality >= QUALITY_FLOOR; quality -= QUALITY_STEP) {
    const candidate = await resized.clone().jpeg({ quality, progressive: false }).toBuffer();
    if (candidate.length <= maxBytes) {
      return { thumbnail: candidate, fits: true };
    }
    last = candidate;
  }
  if (last === undefined) {
    throw new Error("the thumbnail quality range is empty");
  }
  return { thumbnail: last, fits: false };
}

/**
 * The thumbnail a re-check of this picture would hash: makeThumbnail's pick, or its lowest quality
 * when nothing fits. A plain sealed prepare keeps no thumbnail and still has to be judged by the
 * copy an unseal would publish, so this one never refuses on size.
 */
export async function recheckThumbnail(image: Buffer): Promise<Buffer> {
  return (await shrinkToBudget(image, THUMBNAIL_MAX_BYTES)).thumbnail;
}

/**
 * Refuses a picture whose fingerprint does not survive its own thumbnail, measured the way the
 * Chainlink re-check measures it: the registered pHash against the pHash of the thumbnail, over
 * the same match threshold. A picture that only changes from top to bottom leaves the pHash's
 * 8 by 8 block almost empty, so its bits are decided by grain and compression noise and the two
 * land 30 bits apart. Such a passport could never be re-checked as matched, and no re-encoded copy
 * of it could be found by /verify.
 *
 * Returns the distance in bits. Throws FingerprintUnstable past PHASH_MATCH_THRESHOLD, and what
 * phashOf throws for a thumbnail it cannot read.
 */
export async function assertStableFingerprint(phash: bigint, thumbnail: Buffer): Promise<number> {
  const distance = hamming64(phash, await phashOf(thumbnail));
  if (distance > PHASH_MATCH_THRESHOLD) {
    throw new FingerprintUnstable(distance);
  }
  return distance;
}
