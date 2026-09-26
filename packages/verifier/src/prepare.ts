import sharp from "sharp";
import {
  SignerRefusedFile,
  SignerUnavailable,
  cameraRecordFault,
  cameraRecordOf,
  embedManifest,
  readManifest,
  type CameraRecord,
  type CameraRecordPlan,
  type EmbedOptions,
  type ManifestSummary,
} from "./c2pa.js";
import { trainingAssertion, type TrainingConsent } from "./consent.js";
import {
  FingerprintFault,
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
import { safeReason } from "./net/errorText.js";

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
  "this picture cannot be reduced to a thumbnail small enough for the Chainlink verifier to fetch, so a public passport for it could never be re-checked and a sealed one could never be unsealed. Nothing was pinned.";

export const PRIVATE_RECHECK_THUMBNAIL_TOO_LARGE_REASON =
  "this picture cannot be reduced to a thumbnail small enough for the Chainlink verifier to fetch, so a private re-check could never open it. Nothing was pinned.";

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

/**
 * The C2PA reader could not read back the file this service had just signed, or ran past
 * READ_MANIFEST_TIMEOUT_MS doing it (review pass 9, intake 3, V88). Our own signer wrote that file,
 * so this says nothing about the creator's picture, and falling back would register it with no
 * manifest for good. It is a FingerprintFault so every route that registers a picture already
 * answers it 503 service-fault and the creator retries.
 */
export class ReadBackFault extends FingerprintFault {
  constructor(message: string) {
    super(message);
    this.name = "ReadBackFault";
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
  /**
   * Only when the upload arrived with a C2PA store of its own: "kept" when the camera's record is
   * inside Moolam's manifest with its location and serial redacted, "dropped" when it is not.
   */
  cameraRecord?: CameraRecord;
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
  /** As on PreparedImage. An upload whose manifest could not be embedded at all lost its record too. */
  cameraRecord?: CameraRecord;
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
  /** Where the reason a camera's record was dropped is written. Left out, it is not written. */
  log?: PrepareLog;
}

/** The one method of a request logger that preparing a picture uses. */
export interface PrepareLog {
  warn(details: Record<string, unknown>, message: string): void;
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
 * signed file carries no manifest, ReadBackFault when the reader cannot read the signed file back,
 * and ThumbnailTooLarge when no thumbnail small enough can be produced.
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
  const { signed, cameraRecord } = await signKeepingCameraRecord(
    source,
    upright,
    {
      title: opts.title,
      claimGenerator: opts.claimGenerator,
      action: opts.action,
      softBinding: { phash: sourcePrint.phash, blockhash: sourcePrint.blockhash },
      digitalSourceType: opts.digitalSourceType,
      training: opts.training,
    },
    opts.log,
  );

  const signedPrint = await fingerprint(signed);
  if (signedPrint.phash !== sourcePrint.phash) {
    throw new Error(
      `Signing changed the perceptual hash of this ${format} upload, so the soft binding would describe other pixels.`,
    );
  }

  const manifest = await readManifest(signed);
  if (manifest.validation === "unreadable") {
    throw new ReadBackFault(`The C2PA reader could not read back the JPEG just signed from this ${format} upload.`);
  }
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
    ...(cameraRecord === undefined ? {} : { cameraRecord }),
  };
}

/**
 * Signs the upright bytes, and keeps the camera's own signed record when the upload arrived with
 * one (Ram, 2026-09-26): the upload exactly as it came is the parent ingredient, with every
 * assertion and thumbnail that can hold a location or a serial redacted (cameraRecordOf).
 *
 * The signed file is read back before it goes anywhere (cameraRecordFault). A record that fails
 * that read back is dropped, and so is a store that cannot be read and one the library will not
 * take as an ingredient or redact: the file is signed again as a plain upload, and the reason goes
 * to the log. A picture Moolam made itself states c2pa.created and has no parent, so it is signed
 * as it always was, and so is an upload with no store.
 *
 * Throws what embedManifest throws for the plain signing, and SignerUnavailable from either try.
 */
async function signKeepingCameraRecord(
  source: Buffer,
  upright: Buffer,
  embed: EmbedOptions,
  log: PrepareLog | undefined,
): Promise<{ signed: Buffer; cameraRecord?: CameraRecord }> {
  const plan: CameraRecordPlan = embed.action === "c2pa.created" ? { kind: "none" } : await cameraRecordOf(source);
  if (plan.kind === "none") {
    return { signed: await embedManifest(upright, embed) };
  }

  let why: string;
  if (plan.kind === "store") {
    try {
      const signed = await embedManifest(upright, { ...embed, parent: { bytes: source, redactions: plan.redactions } });
      const fault = await cameraRecordFault(signed, plan.secrets);
      if (fault === undefined) {
        return { signed, cameraRecord: "kept" };
      }
      why = fault;
    } catch (error) {
      if (error instanceof SignerUnavailable) {
        throw error;
      }
      why = safeReason(error);
    }
  } else {
    why = plan.why;
  }
  log?.warn({ reason: safeReason(why).slice(0, 200) }, "prepare: camera record dropped");
  return { signed: await embedManifest(upright, embed), cameraRecord: "dropped" };
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
      ...(prepared.cameraRecord === undefined ? {} : { cameraRecord: prepared.cameraRecord }),
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
      detail: safeReason(refused).slice(0, 200),
      ...(await recordLostWithManifest(source, options)),
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
 * The thumbnail budget still applies, to the copy an unseal would publish. A sealed passport keeps
 * the promise that its holder may unseal it later, and /unseal refuses a file whose thumbnail cannot
 * fit the Chainlink fetch budget, for good, since the file is fixed by its sha256. So a picture
 * whose thumbnail cannot fit is refused here, before anything is pinned or registered, exactly as a
 * public prepare refuses it (review pass 8, intake 5, V72).
 *
 * Throws what prepareOrFallback throws: SignerUnavailable when this host can sign nothing at all,
 * ThumbnailTooLarge when the thumbnail an unseal would publish is over THUMBNAIL_MAX_BYTES at the
 * lowest quality, and a training statement this service may not write stops the picture before
 * anything is signed.
 */
export async function prepareSealed(source: Buffer, options: PrepareOptions): Promise<SealedResult> {
  trainingAssertion(options.training);

  let result: SealedResult;
  try {
    const signed = await signImage(source, options);
    result = {
      bytes: signed.original,
      print: signed.fingerprint,
      manifestHash: signed.manifestHash,
      embedded: true,
      ...(signed.cameraRecord === undefined ? {} : { cameraRecord: signed.cameraRecord }),
    };
  } catch (error) {
    const refused = refusalOrThrow(error);
    const upright = await uprightImage(source);
    result = {
      bytes: upright,
      print: await fingerprint(upright),
      manifestHash: ZERO_BYTES32,
      embedded: false,
      reason: NOT_EMBEDDED_REASON,
      detail: safeReason(refused).slice(0, 200),
      ...(await recordLostWithManifest(source, options)),
    };
  }
  unsealThumbnails.set(result.bytes, await makeThumbnail(result.bytes));
  return result;
}

/**
 * The thumbnail prepareSealed judged each sealed file by, so recheckThumbnail hands the route the
 * same one without resizing a large picture twice. Keyed by the very Buffer prepareSealed returned,
 * and gone with it.
 */
const unsealThumbnails = new WeakMap<Buffer, Buffer>();

/**
 * The unsigned fallback pins the upright bytes, which carry no C2PA store, so an upload that
 * arrived with a camera's record has lost it.
 */
async function recordLostWithManifest(source: Buffer, options: PrepareOptions): Promise<{ cameraRecord?: CameraRecord }> {
  if (options.action === "c2pa.created") {
    return {};
  }
  return (await cameraRecordOf(source)).kind === "none" ? {} : { cameraRecord: "dropped" };
}

/**
 * Turns a failure from the signing path into the refusal a caller may fall back on, or lets it
 * out when falling back cannot help: a host that cannot sign at all, a thumbnail over the budget,
 * which the unsigned fallback would make from the very same pixels, and this service failing to
 * fingerprint or to read back its own signed file, ReadBackFault being a FingerprintFault. Those
 * say nothing about the file, and a fault that passed on the second try would otherwise hand the
 * creator an unsigned picture for a signer that never refused it.
 */
function refusalOrThrow(error: unknown): SignerRefusedFile {
  if (error instanceof SignerUnavailable || error instanceof ThumbnailTooLarge || error instanceof FingerprintFault) {
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
 * image quality for no gain. It is rebuilt instead from the segments a decoder needs, byte for
 * byte, so the file pinned to public IPFS for good carries no camera location or serial wherever
 * the camera hid it: the re-encode below drops all of it too (review pass 5, intake 6, and pass 6,
 * intake 1).
 *
 * Transparency is flattened onto white, since a JPEG has no alpha channel to carry it, by the same
 * flatten fingerprint() and the eight variants apply to a query.
 */
export async function uprightImage(source: Buffer): Promise<Buffer> {
  const header = await readImageHeader(source);
  if (header.format === "jpeg" && header.orientation === 1 && !(await isProgressive(source))) {
    const rebuilt = decodableSegmentsOnly(source);
    if (rebuilt !== null) {
      return rebuilt;
    }
  }

  return await flattenedOntoWhite(sharp(source, { limitInputPixels: MAX_IMAGE_PIXELS }).rotate())
    .jpeg({ quality: NORMALISED_QUALITY, progressive: false })
    .toBuffer();
}

/** What the rebuild does with one header segment: keep it, leave it out, or give up and re-encode. */
type SegmentFate = "keep" | "drop" | "re-encode";

const SOI = Buffer.from([0xff, 0xd8]);
const APP0 = 0xe0;
const APP2 = 0xe2;
const APP14 = 0xee;
const COM = 0xfe;
/** Baseline and extended sequential frames, the two the Chainlink sandbox's jpeg-js decodes. */
const SEQUENTIAL_FRAMES = new Set([0xc0, 0xc1]);
/** Quantisation tables, Huffman tables and the restart interval: what the one scan is decoded with. */
const DECODING_TABLES = new Set([0xdb, 0xc4, 0xdd]);

/**
 * The same JPEG rebuilt from the segments that decide its pixels and nothing else: the start
 * marker, the JFIF header, the colour profile, the Adobe colour transform marker, the tables, the
 * one frame, and the one scan up to its end marker. No pixel is decoded or re-encoded, so the
 * picture is exactly the upload's.
 *
 * Every other application segment and every comment is left out, whatever it says: those are
 * where cameras put EXIF, XMP, IPTC, GoPro GPS blocks, maker notes, depth maps and serial numbers,
 * and none of them changes a decoded pixel. Every APP11 segment goes too, the upload's own C2PA
 * store included: a camera's record reaches Moolam's manifest only as the redacted parent
 * ingredient signImage makes from the upload itself, so the signed file holds one store, Moolam's.
 * Nothing after the scan's end marker is kept: a second image, a gain map, a motion clip or a
 * trailer.
 *
 * Returns null, and the caller re-encodes, for anything else: a header segment that could change
 * how the scan decodes and is not one of the tables above, a frame type the sandbox cannot read,
 * more than one frame, a second scan, a scan with no end marker, or a length that runs past the
 * buffer. A structure this does not know costs quality, never a leaked location.
 */
function decodableSegmentsOnly(jpeg: Buffer): Buffer | null {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
    return null;
  }
  const header: { marker: number; bytes: Buffer }[] = [];
  let offset = 2;
  for (;;) {
    if (offset + 4 > jpeg.length || jpeg[offset] !== 0xff) {
      return null;
    }
    const marker = jpeg[offset + 1] as number;
    // Fill bytes before a marker carry no length.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xda) {
      break;
    }
    // Every marker left before the scan carries a length, except the standalone ones below.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      return null;
    }
    const end = offset + 2 + jpeg.readUInt16BE(offset + 2);
    if (end - offset < 4 || end > jpeg.length) {
      return null;
    }
    header.push({ marker, bytes: jpeg.subarray(offset, end) });
    offset = end;
  }

  const scanEnd = endOfScan(jpeg, offset);
  if (scanEnd === null) {
    return null;
  }

  const kept: Buffer[] = [SOI];
  let frames = 0;
  for (const one of header) {
    const fate = fateOf(one.marker, one.bytes.subarray(4));
    if (fate === "re-encode") {
      return null;
    }
    if (fate === "keep") {
      kept.push(one.bytes);
      frames += SEQUENTIAL_FRAMES.has(one.marker) ? 1 : 0;
    }
  }
  if (frames !== 1) {
    return null;
  }
  kept.push(jpeg.subarray(offset, scanEnd));
  return Buffer.concat(kept);
}

/** What happens to one header segment, from its marker and its payload. */
function fateOf(marker: number, payload: Buffer): SegmentFate {
  if (SEQUENTIAL_FRAMES.has(marker) || DECODING_TABLES.has(marker)) {
    return "keep";
  }
  if (marker === APP0) {
    return startsWith(payload, "JFIF\u0000") ? "keep" : "drop";
  }
  if (marker === APP2) {
    return startsWith(payload, "ICC_PROFILE\u0000") ? "keep" : "drop";
  }
  if (marker === APP14) {
    return startsWith(payload, "Adobe") ? "keep" : "drop";
  }
  if ((marker >= 0xe0 && marker <= 0xef) || marker === COM) {
    return "drop";
  }
  return "re-encode";
}

function startsWith(payload: Buffer, prefix: string): boolean {
  return payload.subarray(0, prefix.length).toString("latin1") === prefix;
}

/**
 * Where the one scan that starts at `sos` ends, just past its end marker: the first FF D9 that is
 * neither stuffed data (FF 00) nor a restart marker. Null when the scan header runs past the
 * buffer, when the data meets any other marker first (a second scan, or a DNL), or when it never
 * ends.
 */
function endOfScan(jpeg: Buffer, sos: number): number | null {
  let at = sos + 2 + jpeg.readUInt16BE(sos + 2);
  if (at > jpeg.length) {
    return null;
  }
  while (at + 1 < jpeg.length) {
    if (jpeg[at] !== 0xff) {
      at += 1;
      continue;
    }
    const next = jpeg[at + 1] as number;
    if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
      at += 2;
    } else if (next === 0xff) {
      at += 1;
    } else {
      return next === 0xd9 ? at + 2 : null;
    }
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
 * The thumbnail a re-check of this picture would hash, which is the one an unseal would publish:
 * exactly makeThumbnail's pick. A plain sealed prepare keeps no thumbnail and is judged by this one.
 * For bytes prepareSealed just returned it is the thumbnail prepareSealed already made.
 *
 * Throws ThumbnailTooLarge when nothing fits the budget, as makeThumbnail does. It used to hand
 * back the lowest quality over the budget instead, which let a sealed passport be made that /unseal
 * refuses for good (review pass 8, intake 5, V72).
 */
export async function recheckThumbnail(image: Buffer): Promise<Buffer> {
  return unsealThumbnails.get(image) ?? (await makeThumbnail(image));
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
