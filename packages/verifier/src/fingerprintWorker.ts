import { createRequire } from "node:module";
import { parentPort } from "node:worker_threads";

// This file runs only inside the worker threads fingerprint.ts starts. imghash decodes with
// WebAssembly codecs synchronously and then walks every pixel in JavaScript, which held the main
// thread for over a second on a 40 megapixel upload (review pass 5, answers 1). Here it holds only
// this thread.
//
// The steps are imghash 1.1.4's own hash(), taken apart only so this thread can see whether the
// WebAssembly decoder threw: that decoder leaks its copy of the file when it throws, and imghash
// hides the throw by falling back to jpeg-js (review pass 7, V56). The decoders are loaded from
// where imghash loads them and the hash is imghash's hashRaw, so every stored blockhash stays
// reproducible bit for bit, which test/fingerprint.test.ts checks against imghash.hash on every
// fixture.

interface Pixels {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

const require = createRequire(import.meta.url);
const imghash = require("imghash") as { hashRaw: (pixels: Pixels, bits: number) => string };
const fromImghash = createRequire(require.resolve("imghash"));
const canvas = fromImghash("@canvas/image") as {
  imageFromBuffer: (bytes: Buffer) => Promise<unknown>;
  getImageData: (image: unknown) => Pixels;
};
const jpegJs = fromImghash("jpeg-js") as { decode: (bytes: Buffer, options: { maxMemoryUsageInMB: number }) => Pixels };
const imageType = fromImghash("image-type") as (bytes: Buffer) => { mime: string } | null | undefined;

/** The memory cap imghash hands jpeg-js on its fallback path, copied so the fallback decodes alike. */
const JPEG_FALLBACK_MAX_MEMORY_MB = 1024;

/** One picture to hash: the encoded file, never decoded pixels, and the bits per row. */
export interface BlockhashJob {
  bytes: Uint8Array;
  bits: number;
}

/**
 * The hash, or the reason there is none, and whether the WebAssembly decoder threw on the way. A
 * worker whose decoder threw may be holding memory it will never give back, so it is retired.
 */
export type BlockhashAnswer = ({ hex: string } | { error: string }) & { decoderThrew: boolean };

const port = parentPort;
if (port === null) {
  throw new Error("fingerprintWorker runs only as a worker thread started by fingerprint.ts");
}

port.on("message", (job: BlockhashJob) => {
  const bytes = Buffer.from(job.bytes.buffer, job.bytes.byteOffset, job.bytes.byteLength);
  let decoderThrew = false;
  const hash = async (): Promise<string> => {
    let pixels: Pixels;
    try {
      pixels = canvas.getImageData(await canvas.imageFromBuffer(bytes));
    } catch (error) {
      decoderThrew = true;
      if (imageType(bytes)?.mime !== "image/jpeg") {
        throw error;
      }
      pixels = jpegJs.decode(bytes, { maxMemoryUsageInMB: JPEG_FALLBACK_MAX_MEMORY_MB });
    }
    return imghash.hashRaw(pixels, job.bits);
  };
  hash().then(
    (hex) => port.postMessage({ hex, decoderThrew } satisfies BlockhashAnswer),
    (error: unknown) =>
      port.postMessage({ error: error instanceof Error ? error.message : String(error), decoderThrew } satisfies BlockhashAnswer),
  );
});
