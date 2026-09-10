import sharp from "sharp";
import { embedManifest, readManifest, type ManifestSummary } from "./c2pa.js";
import {
  MAX_IMAGE_PIXELS,
  fingerprint,
  readImageHeader,
  type Fingerprint,
  type Hex,
} from "./fingerprint.js";

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
