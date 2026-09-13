import sharp from "sharp";
import { SignerRefusedFile, SignerUnavailable, embedManifest, readManifest, type ManifestSummary } from "./c2pa.js";
import {
  MAX_IMAGE_PIXELS,
  fingerprint,
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

/** Longest side of the thumbnail in pixels. Small enough to decode fast, large enough to hash. */
export const THUMBNAIL_LONGEST_SIDE = 512;

/**
 * Quality for the baseline JPEG every upload is normalised to before signing. High enough that one
 * re-encode of a creator's PNG is invisible next to the JPEG the studio would have pinned anyway.
 */
const NORMALISED_QUALITY = 95;

/** What a transparent pixel becomes once the picture is a JPEG, which has no alpha channel. */
const FLATTEN_BACKGROUND = "#ffffff";

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

export interface PrepareOptions {
  title: string;
  claimGenerator: string;
  action: "c2pa.created" | "c2pa.edited";
  digitalSourceType?: string;
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
 * signed file carries no readable manifest, or when no thumbnail small enough can be produced.
 */
export async function prepareImage(source: Buffer, opts: PrepareOptions): Promise<PreparedImage> {
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
    thumbnail: await makeThumbnail(signed),
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
 */
export async function prepareOrFallback(source: Buffer, options: PrepareOptions): Promise<PreparedResult> {
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
    if (error instanceof SignerUnavailable) {
      throw error;
    }
    const refused =
      error instanceof SignerRefusedFile
        ? error
        : new SignerRefusedFile(error instanceof Error ? error.message : String(error), { cause: error });

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
 * A JPEG that is already upright and already baseline is handed back untouched, because re-encoding
 * it would cost image quality for no gain.
 *
 * Transparency is flattened onto white, since a JPEG has no alpha channel to carry it.
 */
export async function uprightImage(source: Buffer): Promise<Buffer> {
  const header = await readImageHeader(source);
  if (header.format === "jpeg" && header.orientation === 1 && !(await isProgressive(source))) {
    return source;
  }

  return await sharp(source, { limitInputPixels: MAX_IMAGE_PIXELS })
    .rotate()
    .flatten({ background: FLATTEN_BACKGROUND })
    .jpeg({ quality: NORMALISED_QUALITY, progressive: false })
    .toBuffer();
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
 */
export async function makeThumbnail(image: Buffer): Promise<Buffer> {
  const resized = sharp(image, { limitInputPixels: MAX_IMAGE_PIXELS }).resize({
    width: THUMBNAIL_LONGEST_SIDE,
    height: THUMBNAIL_LONGEST_SIDE,
    fit: "inside",
    withoutEnlargement: true,
  });

  let smallest = Number.POSITIVE_INFINITY;
  for (let quality = QUALITY_START; quality >= QUALITY_FLOOR; quality -= QUALITY_STEP) {
    const candidate = await resized.clone().jpeg({ quality, progressive: false }).toBuffer();
    if (candidate.length <= THUMBNAIL_MAX_BYTES) {
      return candidate;
    }
    smallest = candidate.length;
  }

  throw new Error(
    `The thumbnail is still ${smallest} bytes at quality ${QUALITY_FLOOR}, over the ${THUMBNAIL_MAX_BYTES} byte cap.`,
  );
}
