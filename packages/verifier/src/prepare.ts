import sharp from "sharp";
import { SignerRefusedFile, SignerUnavailable, embedManifest, readManifest, type ManifestSummary } from "./c2pa.js";
import { trainingAssertion, type TrainingConsent } from "./consent.js";
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

/**
 * The same result for a sealed registration, without the two things a sealed passport does not
 * pin. They are missing from the type rather than left unused, so a later convenience cannot pin
 * a thumbnail of a picture the creator asked us not to publish: there is nothing to pin.
 */
export type SealedResult = Omit<PreparedResult, "thumbnail" | "manifestDoc">;

export interface PrepareOptions {
  title: string;
  claimGenerator: string;
  action: "c2pa.created" | "c2pa.edited";
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
 *
 * Throws ThumbnailTooLarge when even the lowest quality is over the budget, and whatever sharp
 * throws for pixels it cannot decode.
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

  throw new ThumbnailTooLarge(
    `The thumbnail is still ${smallest} bytes at quality ${QUALITY_FLOOR}, over the ${THUMBNAIL_MAX_BYTES} byte cap.`,
  );
}
