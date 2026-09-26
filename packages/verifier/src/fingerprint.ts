import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import sharp, { type Metadata, type Sharp } from "sharp";
import type { BlockhashAnswer, BlockhashJob } from "./fingerprintWorker.js";
import type { Hex } from "./types.js";

const require = createRequire(import.meta.url);

// sharp-phash ships no type declarations, so it is loaded through require and given the exact
// shape its README documents. imghash is loaded the same way, inside fingerprintWorker.ts.
const sharpPhash = require("sharp-phash") as (input: Buffer) => Promise<string>;

export type { Hex };

export interface Fingerprint {
  sha256: Hex;
  phash: bigint;
  blockhash: Hex;
  width: number;
  height: number;
  format: string;
}

/**
 * Bits per row handed to imghash. 16 gives a 16x16 grid, so a 256-bit hash in
 * 64 hex characters. More rows means more spatial detail, which is what makes
 * this hash react to crops that the 64-bit pHash shrugs off.
 */
const BLOCKHASH_BITS_PER_ROW = 16;

const PHASH_BITS = 64;
const BLOCKHASH_BITS = BLOCKHASH_BITS_PER_ROW * BLOCKHASH_BITS_PER_ROW;

/**
 * Two images count as the same picture when their pHashes differ by at most
 * this many of 64 bits. Measured by scripts/spike.ts: re-encoding to quality
 * 60, halving the size, quartering the size and stripping metadata all came
 * back at 0 bits, and a 20 percent brightness lift at 3 bits, so 10 leaves
 * headroom over the worst honest case. Cropping 10 percent (21 bits), rotating
 * 90 degrees (31 bits) and mirroring (29 bits) sit above it and are not caught
 * by this hash: those need the rotated and mirrored variants fingerprinted at
 * registration time instead.
 */
export const PHASH_MATCH_THRESHOLD = 10;

/**
 * Same idea for the 256-bit blockhash. The spike measured the same honest
 * transforms at 0 bits, and the brightness lift at 10 bits, so 40 is roughly
 * four times the worst honest case and still far below the 74 bits a 10 percent
 * crop produced or the 128 bits a random pair averages.
 */
export const BLOCKHASH_MATCH_THRESHOLD = 40;

/**
 * The most pixels we will decode from an image a stranger sent, 40 megapixels.
 * Decoding is what costs memory, not the file: a 572 KB JPEG that unpacks to
 * 100 megapixels took the service to 917 MB of resident memory. 40 megapixels
 * covers every camera on sale and holds one decode to roughly 160 MB.
 */
export const MAX_IMAGE_PIXELS = 40_000_000;

/**
 * What a transparent pixel becomes before anything is hashed or signed. Registration writes a JPEG,
 * which has no alpha channel, so the signed file is flattened onto this; a query is flattened onto
 * the same colour, or a logo that kept its transparency would never match its own passport.
 */
export const FLATTEN_BACKGROUND = "#ffffff";

/**
 * The one flatten both sides use: prepare.ts before it signs, and the fingerprint and the eight
 * variants before they hash. A picture with no alpha channel comes out of it unchanged.
 */
export function flattenedOntoWhite(pipeline: Sharp): Sharp {
  return pipeline.flatten({ background: FLATTEN_BACKGROUND });
}

/** Raised when an image is over the pixel limit, so a route can answer 413 rather than 400. */
export class ImageTooLarge extends Error {}

/**
 * Raised for bytes that are not a JPEG, a PNG or a WebP. Sharp reads many more formats, and some
 * of them cost what their content says rather than what their size says: a few hundred bytes of
 * SVG filters held a decode slot for 22 seconds (review pass 4, V17).
 */
export class UnsupportedImageFormat extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedImageFormat";
  }
}

/**
 * The raster formats the studio and the verify page take, the same three the web's ACCEPT list
 * names. Each is recognised by its own file signature, which covers the container and says
 * nothing about whether the pixels inside decode: that is still sharp's job, after this check.
 */
const RASTER_SIGNATURES: Record<"jpeg" | "png" | "webp", (bytes: Buffer) => boolean> = {
  jpeg: (bytes) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  png: (bytes) =>
    bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  webp: (bytes) =>
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    bytes.subarray(8, 12).toString("latin1") === "WEBP",
};

/** Which of the three raster formats these bytes start as, or undefined for anything else. */
function rasterFormatOf(bytes: Buffer): keyof typeof RASTER_SIGNATURES | undefined {
  return (Object.keys(RASTER_SIGNATURES) as (keyof typeof RASTER_SIGNATURES)[]).find((format) =>
    RASTER_SIGNATURES[format](bytes),
  );
}

export interface ImageHeader {
  width: number;
  height: number;
  format: string;
  /** The EXIF orientation tag, 1 when the file carries none. */
  orientation: number;
  /** True when the file carries an alpha channel, which is flattened onto white before hashing. */
  hasAlpha: boolean;
}

/**
 * Reads the header of an image and refuses one that would decode to more pixels
 * than we are willing to hold. The header is parsed without decoding, so the
 * refusal costs nothing.
 *
 * Only a JPEG, a PNG or a WebP gets as far as sharp: the file signature is checked first, so a
 * vector, a GIF, a TIFF or anything else is refused before any library reads it. Sharp's own
 * reading of the format then has to agree with the signature, so a file one parser calls a PNG and
 * the other calls something else is refused too. Every route that reads an upload goes through
 * here before anything decodes it.
 *
 * Throws UnsupportedImageFormat for any other format, ImageTooLarge past the pixel limit, and a
 * plain Error when the bytes are not an image sharp can read.
 */
export async function readImageHeader(bytes: Buffer): Promise<ImageHeader> {
  const signed = rasterFormatOf(bytes);
  if (signed === undefined) {
    throw new UnsupportedImageFormat("only JPEG, PNG and WebP pictures are taken");
  }

  let metadata: Metadata;
  try {
    metadata = await sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS }).metadata();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (/pixel limit/i.test(detail)) {
      throw new ImageTooLarge(`the image is over the ${MAX_IMAGE_PIXELS} pixel limit this service decodes`);
    }
    throw error;
  }
  if (metadata.format !== signed) {
    throw new UnsupportedImageFormat("only JPEG, PNG and WebP pictures are taken");
  }

  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width * height > MAX_IMAGE_PIXELS) {
    throw new ImageTooLarge(
      `the image is ${width}x${height} pixels, over the ${MAX_IMAGE_PIXELS} pixel limit this service decodes`,
    );
  }
  return {
    width,
    height,
    format: metadata.format ?? "unknown",
    orientation: metadata.orientation ?? 1,
    hasAlpha: metadata.hasAlpha === true,
  };
}

/**
 * Computes the three fingerprints Moolam stores for an image: the exact-bytes
 * sha256, a 64-bit pHash and a 256-bit blockhash, plus the pixel dimensions and
 * container format.
 *
 * The sha256 is of the bytes exactly as they arrived. The two perceptual hashes
 * are taken from the upright picture flattened onto white, so a sideways phone
 * photo and the same photo turned the right way up fingerprint alike, and a
 * transparent PNG hashes as the white-backed JPEG registration signed. The
 * dimensions reported are the upright ones.
 *
 * Throws when the buffer is empty, when it is not a JPEG, PNG or WebP
 * (UnsupportedImageFormat), when the image is over the pixel limit
 * (ImageTooLarge), or when it is not an image sharp can decode.
 */
export async function fingerprint(bytes: Buffer): Promise<Fingerprint> {
  if (bytes.length === 0) {
    throw new Error("fingerprint needs a non-empty image buffer");
  }

  const header = await readImageHeader(bytes);
  const oriented = await hashableImage(bytes, header);
  const [phashBits, blockhashHex] = await Promise.all([
    sharpPhash(oriented.bytes),
    blockhashOffThread(oriented.bytes, oriented.width * oriented.height),
  ]);

  if (phashBits.length !== PHASH_BITS) {
    throw new Error(`expected a ${PHASH_BITS} bit pHash, got ${phashBits.length} bits`);
  }
  if (blockhashHex.length !== BLOCKHASH_BITS / 4) {
    throw new Error(`expected a ${BLOCKHASH_BITS} bit blockhash, got ${blockhashHex.length * 4} bits`);
  }

  return {
    sha256: `0x${createHash("sha256").update(bytes).digest("hex")}`,
    phash: BigInt(`0b${phashBits}`),
    blockhash: `0x${blockhashHex}`,
    width: oriented.width,
    height: oriented.height,
    format: header.format,
  };
}

/**
 * The pHash alone, from the same pixels fingerprint() hashes. Prepare uses it to ask whether a
 * picture's own thumbnail still reads as the picture, without paying for a blockhash nobody reads.
 *
 * Throws what fingerprint() throws for bytes it cannot read.
 */
export async function phashOf(bytes: Buffer): Promise<bigint> {
  if (bytes.length === 0) {
    throw new Error("phashOf needs a non-empty image buffer");
  }
  const oriented = await hashableImage(bytes, await readImageHeader(bytes));
  const bits = await sharpPhash(oriented.bytes);
  if (bits.length !== PHASH_BITS) {
    throw new Error(`expected a ${PHASH_BITS} bit pHash, got ${bits.length} bits`);
  }
  return BigInt(`0b${bits}`);
}

/**
 * The pixels both hashes are taken from: the picture the way a person sees it,
 * with any EXIF orientation already applied and any transparency flattened onto
 * white.
 *
 * A phone photo taken sideways stores its pixels rotated and leaves a tag
 * saying which way up it goes. Hashing the stored pixels would give the same
 * picture two different fingerprints depending on whether the viewer honoured
 * the tag, so the rotation is applied here, once, and both hashes read the same
 * buffer. The rewritten copy is a PNG because it is lossless: re-encoding to
 * JPEG would add compression noise to the very thing being measured.
 *
 * Transparency is flattened because sharp-phash premultiplies alpha around its
 * resize, so a transparent area reads as black, while registration signs the
 * picture flattened onto white (review pass 5, intake 3).
 *
 * A file with no rotation to apply and no alpha channel is handed on untouched.
 * Its stored pixels are already the ones to hash, and skipping the re-encode
 * keeps every fingerprint recorded before these checks byte for byte
 * reproducible.
 */
async function hashableImage(
  bytes: Buffer,
  header: ImageHeader,
): Promise<{ bytes: Buffer; width: number; height: number }> {
  if (header.orientation === 1 && !header.hasAlpha) {
    return { bytes, width: header.width, height: header.height };
  }

  const upright = sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS }).rotate();
  const { data, info } = await (header.hasAlpha ? flattenedOntoWhite(upright) : upright)
    .png({ compressionLevel: 3 })
    .toBuffer({ resolveWithObject: true });
  return { bytes: data, width: info.width, height: info.height };
}

/**
 * How many blockhash decodes run at once, each on its own worker thread. Two is the match gate's
 * width, and dihedralFingerprints queues its eight small variants behind them.
 */
const BLOCKHASH_WORKERS = 2;

/**
 * A worker that decoded more pixels than this is replaced rather than kept. WebAssembly memory
 * grows to fit the largest picture it has held and never shrinks, and one 40 megapixel decode left
 * about 440 MB resident in the review's measurement (answers 1). Eight megapixels covers the
 * variants and every thumbnail, so only a large upload pays for a fresh worker.
 */
const RECYCLE_AFTER_PIXELS = 8_000_000;

/** Far past the 1 to 1.5 seconds a 40 megapixel decode measured, so only a stuck worker meets it. */
const BLOCKHASH_TIMEOUT_MS = 30_000;

/** The compiled service runs fingerprintWorker.js; the tests and tsx run the .ts beside this file. */
const WORKER_URL = new URL(
  import.meta.url.endsWith(".ts") ? "./fingerprintWorker.ts" : "./fingerprintWorker.js",
  import.meta.url,
);

interface BlockhashRequest {
  bytes: Buffer;
  pixels: number;
  resolve: (hex: string) => void;
  reject: (error: Error) => void;
}

const waiting: BlockhashRequest[] = [];
const idleWorkers: Worker[] = [];
let runningWorkers = 0;

/**
 * The imghash blockhash of an encoded picture, worked out on a worker thread so the thread that
 * answers requests never decodes pixels itself. A caller waits in line when both workers are busy.
 *
 * Rejects with imghash's own message for a file it cannot decode, and with a plain Error when a
 * worker crashes or runs past BLOCKHASH_TIMEOUT_MS; that worker is thrown away and the next
 * request gets a fresh one.
 */
function blockhashOffThread(bytes: Buffer, pixels: number): Promise<string> {
  return new Promise((resolve, reject) => {
    waiting.push({ bytes, pixels, resolve, reject });
    startWaiting();
  });
}

function startWaiting(): void {
  while (runningWorkers < BLOCKHASH_WORKERS && waiting.length > 0) {
    const request = waiting.shift() as BlockhashRequest;
    runningWorkers += 1;
    runOn(idleWorkers.pop() ?? new Worker(WORKER_URL), request);
  }
}

function runOn(worker: Worker, request: BlockhashRequest): void {
  let settled = false;
  const finish = (outcome: { hex: string } | { error: Error }, broken: boolean): void => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    worker.off("message", onMessage);
    worker.off("error", onError);
    worker.off("exit", onExit);
    runningWorkers -= 1;
    if (broken || request.pixels > RECYCLE_AFTER_PIXELS) {
      void worker.terminate();
    } else {
      // An idle worker must not keep a script or a test process alive on its own.
      worker.unref();
      idleWorkers.push(worker);
    }
    if ("hex" in outcome) {
      request.resolve(outcome.hex);
    } else {
      request.reject(outcome.error);
    }
    startWaiting();
  };
  const onMessage = (answer: BlockhashAnswer): void => {
    finish("hex" in answer ? { hex: answer.hex } : { error: new Error(answer.error) }, false);
  };
  const onError = (error: Error): void => finish({ error }, true);
  const onExit = (code: number): void =>
    finish({ error: new Error(`the blockhash worker stopped with code ${code}`) }, true);
  const timer = setTimeout(
    () => finish({ error: new Error(`the blockhash took longer than ${BLOCKHASH_TIMEOUT_MS} ms`) }, true),
    BLOCKHASH_TIMEOUT_MS,
  );

  worker.on("message", onMessage);
  worker.on("error", onError);
  worker.on("exit", onExit);
  worker.ref();
  // A copy of exactly these bytes, handed over rather than cloned: a Buffer can be a view into a
  // much larger allocation, and cloning a view clones all of it.
  const copy = new Uint8Array(request.bytes);
  const job: BlockhashJob = { bytes: copy, bits: BLOCKHASH_BITS_PER_ROW };
  worker.postMessage(job, [copy.buffer]);
}

/** Counts the differing bits between two 64-bit pHashes. */
export function hamming64(a: bigint, b: bigint): number {
  const mask = (1n << 64n) - 1n;
  let diff = (a ^ b) & mask;
  let bits = 0;
  while (diff !== 0n) {
    diff &= diff - 1n;
    bits += 1;
  }
  return bits;
}

/** Counts the differing bits between two hex hashes of the same length. */
export function hammingHex(a: Hex, b: Hex): number {
  const left = a.slice(2).toLowerCase();
  const right = b.slice(2).toLowerCase();
  if (left.length !== right.length) {
    throw new Error(`hammingHex needs equal length hashes, got ${left.length} and ${right.length}`);
  }

  let bits = 0;
  for (let i = 0; i < left.length; i += 1) {
    const l = Number.parseInt(left[i] ?? "", 16);
    const r = Number.parseInt(right[i] ?? "", 16);
    if (Number.isNaN(l) || Number.isNaN(r)) {
      throw new Error("hammingHex needs hex strings prefixed with 0x");
    }
    let nibble = l ^ r;
    while (nibble !== 0) {
      nibble &= nibble - 1;
      bits += 1;
    }
  }
  return bits;
}
