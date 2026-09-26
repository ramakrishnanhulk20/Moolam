import { createRequire } from "node:module";
import { parentPort } from "node:worker_threads";

// This file runs only inside the worker threads fingerprint.ts starts. imghash decodes with
// WebAssembly codecs synchronously and then walks every pixel in JavaScript, which held the main
// thread for over a second on a 40 megapixel upload (review pass 5, answers 1). Here it holds only
// this thread. It is the same library called the same way, so every stored blockhash stays
// reproducible bit for bit.

const require = createRequire(import.meta.url);
const imghash = require("imghash") as {
  hash: (input: Buffer, bits: number, format: "hex") => Promise<string>;
};

/** One picture to hash: the encoded file, never decoded pixels, and the bits per row. */
export interface BlockhashJob {
  bytes: Uint8Array;
  bits: number;
}

export type BlockhashAnswer = { hex: string } | { error: string };

const port = parentPort;
if (port === null) {
  throw new Error("fingerprintWorker runs only as a worker thread started by fingerprint.ts");
}

port.on("message", (job: BlockhashJob) => {
  const bytes = Buffer.from(job.bytes.buffer, job.bytes.byteOffset, job.bytes.byteLength);
  imghash.hash(bytes, job.bits, "hex").then(
    (hex) => port.postMessage({ hex } satisfies BlockhashAnswer),
    (error: unknown) =>
      port.postMessage({ error: error instanceof Error ? error.message : String(error) } satisfies BlockhashAnswer),
  );
});
