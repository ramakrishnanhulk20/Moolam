import { readFileSync } from "node:fs";
import { parentPort } from "node:worker_threads";
import { Builder, LocalSigner } from "@contentauth/c2pa-node";

// This file runs only inside the worker thread c2pa.ts starts. The C2PA library's Builder.sign is a
// blocking native call that hashes the whole file and makes the claim thumbnail, which held the
// thread that answers requests for 913 ms on a 22 MB JPEG (review pass 8, intake 4, V71). Here it
// holds only this thread. The library's own signAsync takes only a callback signer, not the local
// certificate and key this service signs with, so a thread of our own is the way off.
//
// It imports nothing from this package at run time: the tests start the .ts file directly under
// Node's own type stripping, which does not rewrite "./x.js" imports to the .ts beside them. Every
// check on the options stays in embedManifest, and this file only replays what it was told.

/** One assertion as embedManifest built it, added to the manifest in the order given. */
export interface SigningAssertion {
  label: string;
  data: unknown;
}

/** Everything one signing needs, all of it plain data a thread can be handed. */
export interface SigningJob {
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: string;
  /** The manifest definition handed to Builder.withJson. */
  definition: Parameters<typeof Builder.withJson>[0];
  /** The reader settings every C2PA read in this service uses, remote fetches off. */
  settings: Parameters<typeof Builder.withJson>[1];
  intent: Parameters<Builder["setIntent"]>[0];
  /** Added before the parent ingredient, so its redactions land in this actions assertion. */
  before: SigningAssertion[];
  parent?: {
    bytes: Uint8Array<ArrayBuffer>;
    mimeType: string;
    ingredient: string;
    redactions: string[];
    reason: Parameters<Builder["addRedaction"]>[1];
  };
  after: SigningAssertion[];
  identity: { certPath: string; keyPath: string };
  /** How long reading the parent's store may take before the parent is refused. */
  readLimitMs: number;
}

/**
 * The signed file, or why there is none. "refused" is the library turning down this file, its
 * parent or a redaction; "unavailable" is a signing identity that would not load; "invalid" is a
 * manifest the library would not build, which embedManifest's own checks should already have caught.
 */
export type SigningAnswer = { signed: Uint8Array } | { kind: "refused" | "unavailable" | "invalid"; error: string };

class Refused extends Error {}
class Unavailable extends Error {}

let held: { key: string; signer: LocalSigner } | undefined;

/**
 * The signer for this identity, made once and kept. A certificate and key swapped on disk under the
 * same paths are picked up by the next worker, which a restart of the service gives.
 */
function signerFor(identity: SigningJob["identity"]): LocalSigner {
  const key = `${identity.certPath}\n${identity.keyPath}`;
  if (held?.key !== key) {
    try {
      held = { key, signer: LocalSigner.newSigner(readFileSync(identity.certPath), readFileSync(identity.keyPath), "es256") };
    } catch (error) {
      throw new Unavailable(error instanceof Error ? error.message : String(error));
    }
  }
  return held.signer;
}

async function withinReadLimit<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the C2PA read was still running after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, limit]);
  } finally {
    clearTimeout(timer);
  }
}

function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

async function sign(job: SigningJob): Promise<Buffer> {
  const builder = Builder.withJson(job.definition, job.settings);
  builder.setIntent(job.intent);
  for (const one of job.before) {
    builder.addAssertion(one.label, one.data, "Cbor");
  }
  if (job.parent !== undefined) {
    try {
      await withinReadLimit(
        builder.addIngredient(job.parent.ingredient, { buffer: asBuffer(job.parent.bytes), mimeType: job.parent.mimeType }),
        job.readLimitMs,
      );
      for (const uri of job.parent.redactions) {
        builder.addRedaction(uri, job.parent.reason);
      }
    } catch (error) {
      throw new Refused(error instanceof Error ? error.message : String(error));
    }
  }
  for (const one of job.after) {
    builder.addAssertion(one.label, one.data, "Cbor");
  }

  const signer = signerFor(job.identity);
  const destination: { buffer: Buffer | null } = { buffer: null };
  try {
    builder.sign(signer, { buffer: asBuffer(job.bytes), mimeType: job.mimeType }, destination);
  } catch (error) {
    throw new Refused(error instanceof Error ? error.message : String(error));
  }
  if (destination.buffer === null) {
    throw new Refused("the C2PA library signed the image but gave no bytes back");
  }
  return destination.buffer;
}

const port = parentPort;
if (port === null) {
  throw new Error("signingWorker runs only as a worker thread started by c2pa.ts");
}

port.on("message", (job: SigningJob) => {
  sign(job).then(
    (signed) => {
      // A copy of exactly the signed bytes, handed over rather than cloned, for the same reason
      // fingerprint.ts copies before it posts: a Buffer can be a view into a larger allocation.
      const copy = new Uint8Array(signed);
      port.postMessage({ signed: copy } satisfies SigningAnswer, [copy.buffer]);
    },
    (error: unknown) => {
      const kind = error instanceof Refused ? "refused" : error instanceof Unavailable ? "unavailable" : "invalid";
      port.postMessage({ kind, error: error instanceof Error ? error.message : String(error) } satisfies SigningAnswer);
    },
  );
});
