import { execFileSync } from "node:child_process";
import { X509Certificate, createHash, createPrivateKey } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { LocalSigner, Reader, createVerifySettings, settingsToJson } from "@contentauth/c2pa-node";
import sharp from "sharp";
import { TRAINING_ASSERTION_LABEL, trainingAssertion, type TrainingConsent } from "./consent.js";
import { env } from "./env.js";
import { FingerprintFault, MAX_IMAGE_PIXELS } from "./fingerprint.js";
import type { SigningAnswer, SigningAssertion, SigningJob } from "./signingWorker.js";
import type { Hex } from "./types.js";

export interface SoftBinding {
  alg: string;
  phash: bigint;
  blockhash: Hex;
}

export interface ManifestSummary {
  present: boolean;
  /**
   * What the C2PA library's own validation made of the manifest. "valid" means the signature and
   * the bindings to these bytes check out; the signer is not looked up on any trust list. "invalid"
   * means the file was altered after signing or the manifest was moved here from another file.
   * "unreadable" means the file carries a manifest that could not be parsed at all. Left off when
   * the file carries no manifest.
   */
  validation?: "valid" | "invalid" | "unreadable";
  /**
   * Set only on a "valid" manifest the library itself failed for its signing certificate alone:
   * "expired" when a certificate that signed it, Moolam's or an ingredient's, has since expired,
   * "untrusted" when the only complaint is trust. The signature and the bindings still hold.
   */
  credential?: "expired" | "untrusted";
  /**
   * The library's failure codes, such as "assertion.dataHash.mismatch", from the active manifest
   * and from every ingredient's deltas. Sent with an invalid manifest, and with a valid one that
   * carries `credential`, so the certificate's own code is named.
   */
  failures?: string[];
  manifestHash?: Hex;
  title?: string;
  claimGenerator?: string;
  actions?: string[];
  ingredients?: number;
  softBinding?: SoftBinding;
}

/**
 * Our entry in the C2PA soft binding algorithm list: the 64-bit pHash and the
 * 256-bit blockhash of the image, concatenated. The version suffix is part of
 * the name so a later change to either hash gets its own identifier rather than
 * quietly breaking every reader.
 */
export const SOFT_BINDING_ALG = "com.moolam.phash-blockhash.v1";

/**
 * This host cannot sign anything at all: the certificate or the key is not where the environment
 * points, only one of the two paths is set, openssl is not installed to make the development
 * identity, the leaf is outside its validity window, the key is not the leaf's, or the library
 * refused to sign for the certificate's sake. No file can get past it, so a caller has to stop rather than
 * quietly pin unsigned pictures for everyone. A signing worker that crashed, stopped or hung is answered the same way:
 * it says nothing about the file, so the file must not be pinned unsigned for it either.
 */
export class SignerUnavailable extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SignerUnavailable";
  }
}

/**
 * The signer is there and working, but it would not take this particular file. The picture still
 * has a fingerprint and can still be registered, it just loses the provenance that travels inside
 * the file, so a caller may fall back.
 */
export class SignerRefusedFile extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SignerRefusedFile";
  }
}

const SOFT_BINDING_LABEL = "c2pa.soft-binding";
const PHASH_BYTES = 8;
const BLOCKHASH_BYTES = 32;

const AI_SOURCE_TYPE = "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia";

const CREATED_ACTION = "c2pa.created";
const OPENED_ACTION = "c2pa.opened";

const packageRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const devCertDir = path.join(packageRoot, "test-assets", "certs");

/** The answer for a file whose manifest, or whose container, the reader could not parse. */
export function manifestUnreadable(): ManifestSummary {
  return { present: false, validation: "unreadable" };
}

const MAX_FAILURE_CODES = 8;

/** How long one manifest read may take before the file is answered as unreadable. */
export const READ_MANIFEST_TIMEOUT_MS = 5_000;

/**
 * The reader is told never to fetch a remote manifest. The installed library does fetch one when a
 * file with no embedded store names an address in its XMP (review pass 6, answers 3, measured in
 * test/intake-bytes.test.ts), and that request would leave this host outside safeFetch's checks
 * and with no time limit, to wherever an uploader pointed it.
 */
const READER_SETTINGS = settingsToJson(createVerifySettings({ remoteManifestFetch: false }));

/**
 * Reads any C2PA manifest embedded in an image, and whether it validates.
 *
 * Never throws. A file with no manifest, or empty bytes, is present false. A
 * file the library cannot parse, a JPEG that still carries C2PA segments the
 * library could not read, a file that names a remote manifest (never fetched),
 * and a read still running after READ_MANIFEST_TIMEOUT_MS are present false with
 * validation "unreadable", so a damaged manifest costs the caller the manifest
 * and never the match. A read given up on keeps running in the library until it
 * ends, and its answer is dropped. A manifest that parses is present, with the
 * library's own validation state: anything but a clean pass reads as invalid,
 * except a failure that is only about the signing certificate (see judged).
 * Checking the signing certificate against a trust list is deliberately not done
 * here: the spike signs with a throwaway certificate, so every manifest it reads
 * back is reported as untrusted.
 */
export async function readManifest(bytes: Buffer): Promise<ManifestSummary> {
  if (bytes.length === 0) {
    return { present: false };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<ManifestSummary>((resolve) => {
    timer = setTimeout(() => resolve(manifestUnreadable()), READ_MANIFEST_TIMEOUT_MS);
  });
  try {
    return await Promise.race([summarise(bytes).catch(() => manifestUnreadable()), limit]);
  } finally {
    clearTimeout(timer);
  }
}

async function summarise(bytes: Buffer): Promise<ManifestSummary> {
  const reader = await Reader.fromAsset({ buffer: bytes, mimeType: sniffMimeType(bytes) }, READER_SETTINGS);
  const active = reader?.getActive();
  if (reader === null || active === undefined) {
    // The library answers "nothing here" for a store whose boxes it cannot parse, so the segments
    // themselves are what tell a broken manifest apart from a file that never had one. A box that
    // plainly names itself as something else is not a manifest; one whose name cannot be read may
    // be the store, damaged.
    return mayHoldStore(jumbfPackets(bytes)) ? manifestUnreadable() : { present: false };
  }

  const store = reader.json();

  const actions = (active.assertions ?? [])
    .filter((assertion) => assertion.label?.startsWith("c2pa.actions"))
    .flatMap((assertion) => {
      const data = assertion.data as { actions?: { action?: string }[] } | undefined;
      return (data?.actions ?? []).map((entry) => entry.action).filter((name): name is string => Boolean(name));
    });

  const generator = active.claim_generator_info?.[0];
  const manifestStore = extractManifestStore(bytes);
  const softBinding = parseSoftBinding(active.assertions ?? []);

  return {
    present: true,
    ...judged(store),
    manifestHash:
      manifestStore === null ? undefined : `0x${createHash("sha256").update(manifestStore).digest("hex")}`,
    title: active.title ?? undefined,
    claimGenerator:
      generator === undefined
        ? (active.claim_generator ?? undefined)
        : `${generator.name} ${generator.version ?? ""}`.trim(),
    actions,
    ingredients: active.ingredients?.length ?? 0,
    softBinding,
  };
}

/**
 * Pulls our fingerprint back out of a c2pa.soft-binding assertion.
 *
 * The C2PA library hands CBOR byte strings back as base64, so the 40 byte value
 * is decoded here: eight bytes of big-endian pHash then 32 bytes of blockhash.
 * Anything with a different algorithm name or a wrong length is treated as
 * absent rather than guessed at.
 */
function parseSoftBinding(assertions: { label?: string; data?: unknown }[]): SoftBinding | undefined {
  for (const assertion of assertions) {
    if (!assertion.label?.startsWith(SOFT_BINDING_LABEL)) {
      continue;
    }
    const data = assertion.data as
      | { alg?: string; blocks?: { value?: unknown }[] }
      | undefined;
    if (data?.alg !== SOFT_BINDING_ALG) {
      continue;
    }
    const raw = data.blocks?.[0]?.value;
    const value = decodeAssertionBytes(raw);
    if (value === null || value.length !== PHASH_BYTES + BLOCKHASH_BYTES) {
      continue;
    }
    return {
      alg: data.alg,
      phash: value.readBigUInt64BE(0),
      blockhash: `0x${value.subarray(PHASH_BYTES).toString("hex")}`,
    };
  }
  return undefined;
}

type ManifestStore = ReturnType<Reader["json"]>;

/**
 * The two codes the library raises about the signing certificate alone. Moolam signs with no trusted
 * timestamp, so the library judges the certificate against today: once a leaf that signed a file
 * expires, that untouched file fails with "signingCredential.expired", and every certificate off a
 * trust list, which is every one here, carries "signingCredential.untrusted". Neither says a byte or
 * a claim changed. Any other code, "signingCredential.revoked" and "signingCredential.invalid"
 * included, is not on this list and so keeps a manifest invalid: an unknown code fails closed.
 */
const CREDENTIAL_ONLY = new Set(["signingCredential.expired", "signingCredential.untrusted"]);

/**
 * The validation a manifest is answered with. A clean pass from the library is valid. A failure is
 * valid too when every code reported anywhere, in the active manifest, in each ingredient's deltas
 * and in the flat list, is one of CREDENTIAL_ONLY, and `credential` then names which: the signature
 * and the hard bindings held, only the certificate's standing changed. Anything else is invalid.
 * The decision reads every raw entry before any is filtered or capped for the answer, so a code that
 * would be left out of `failures` still makes the manifest invalid.
 */
function judged(store: ManifestStore): Pick<ManifestSummary, "validation" | "credential" | "failures"> {
  const state = store.validation_state;
  if (state === "Valid" || state === "Trusted") {
    return { validation: "valid" };
  }
  const reported = reportedFailures(store);
  const failures = failureCodes(store);
  const credentialOnly =
    reported.length > 0 && reported.every((entry) => typeof entry.code === "string" && CREDENTIAL_ONLY.has(entry.code));
  if (!credentialOnly) {
    return { validation: "invalid", failures };
  }
  const expired = reported.some((entry) => entry.code === "signingCredential.expired");
  return { validation: "valid", credential: expired ? "expired" : "untrusted", failures };
}

/**
 * Every failure the library reported: the active manifest's, each ingredient's deltas, where an
 * ingredient's own certificate expiring is recorded, and the flat status list.
 */
function reportedFailures(store: ManifestStore): { code?: unknown }[] {
  const results = store.validation_results;
  return [
    ...(results?.activeManifest?.failure ?? []),
    ...(results?.ingredientDeltas ?? []).flatMap((one) => one.validationDeltas?.failure ?? []),
    ...(store.validation_status ?? []),
  ];
}

/**
 * The failure codes reportedFailures finds, once each. Each code is passed on to callers, so only
 * short dotted names are kept and the list is capped: a crafted manifest cannot use this field to
 * smuggle text into the answer.
 */
function failureCodes(store: ManifestStore): string[] {
  const codes = reportedFailures(store)
    .map((entry) => entry.code)
    .filter((code): code is string => typeof code === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(code));
  return [...new Set(codes)].slice(0, MAX_FAILURE_CODES);
}

function decodeAssertionBytes(raw: unknown): Buffer | null {
  if (typeof raw === "string") {
    return Buffer.from(raw, "base64");
  }
  if (Array.isArray(raw) && raw.every((entry) => typeof entry === "number")) {
    return Buffer.from(raw as number[]);
  }
  return null;
}

export interface EmbedOptions {
  title: string;
  claimGenerator: string;
  /**
   * "c2pa.created" for a picture Moolam itself made, which states a source type. Any other action,
   * "c2pa.opened" or "c2pa.edited", is for a file somebody handed Moolam and states none.
   */
  action: string;
  softBinding: { phash: bigint; blockhash: Hex };
  /** Only with "c2pa.created". Left out there, the picture is declared AI generated. */
  digitalSourceType?: string;
  /** What the creator said about AI use. Left out means they said nothing, and nothing is written. */
  training?: TrainingConsent;
  /**
   * The upload exactly as it arrived, when it carries a C2PA store of its own: it becomes the one
   * parentOf ingredient, so the camera's hard binding is checked against the bytes the camera
   * signed. Never with "c2pa.created", which has no parent.
   */
  parent?: {
    bytes: Buffer;
    /** JUMBF URIs of the parent's assertions to redact, each with the reason c2pa.PII.present. */
    redactions: readonly string[];
  };
}

/**
 * Signs a new C2PA manifest into a copy of the image and returns the signed
 * bytes.
 *
 * The manifest states only what Moolam saw (review pass 4, V22). A picture
 * Moolam made itself is "c2pa.created" under the create intent, with its
 * digital source type, which defaults to AI generated. A file somebody handed
 * Moolam is signed under the edit intent instead: the file becomes the parent
 * ingredient and the library records "c2pa.opened" for it, then the action
 * given, when it is not "c2pa.opened" itself. No source type is written for
 * such a file, because the C2PA library has no form for a source type that is
 * only the uploader's claim, and one written under Moolam's signature would be
 * Moolam saying how a picture was made when it only saw the finished file. A
 * created action needs a source type to validate, which is why an upload is
 * never recorded as created.
 *
 * The soft binding is required, not optional. A hard binding breaks the moment
 * a platform re-encodes the file, so without the fingerprint in the manifest
 * there is nothing left to match a re-uploaded copy against. It is written as a
 * c2pa.soft-binding assertion in the shape the C2PA 2.1 spec gives in section
 * 18.9: one alg name, one block, and the fingerprint as a CBOR byte string.
 *
 * What the creator said about AI use is written the same way, as one
 * cawg.training-mining assertion, so the statement is inside the signature from
 * the first second rather than sitting in a database the file never travels
 * with. A creator who said nothing gets no assertion, because silence is not
 * permission.
 *
 * An upload that arrived with its own C2PA store is given as `parent`: the
 * upload's original bytes become the one parentOf ingredient, in place of the
 * plain parent the edit intent would make from `bytes`, and each redaction in
 * it is recorded with the reason c2pa.PII.present.
 *
 * The library's sign is a blocking native call that hashes the whole file, so
 * it runs on a worker thread of its own that holds the signer (review pass 8,
 * intake 4, V71). Every check on the options is made here first, and the
 * worker builds the manifest from exactly what this function decided. One
 * file is signed at a time, in the order they came.
 *
 * Throws when the buffer is empty, when the options are incomplete, when a
 * source type is given with any action but "c2pa.created" or a parent with
 * it, when the fingerprint is the wrong size, when the training statement is
 * not one this service may write, SignerUnavailable when no signing identity
 * can be resolved or the signing worker failed, and SignerRefusedFile when the
 * C2PA library rejects this container, the parent, or one of its redactions.
 */
export async function embedManifest(bytes: Buffer, opts: EmbedOptions): Promise<Buffer> {
  if (bytes.length === 0) {
    throw new Error("embedManifest needs a non-empty image buffer");
  }
  if (opts.title.length === 0 || opts.claimGenerator.length === 0 || opts.action.length === 0) {
    throw new Error("embedManifest needs a title, a claim generator and an action");
  }
  const created = opts.action === CREATED_ACTION;
  if (!created && opts.digitalSourceType !== undefined) {
    throw new Error(`embedManifest states a source type only for ${CREATED_ACTION}, never for ${opts.action}`);
  }
  if (created && opts.parent !== undefined) {
    throw new Error(`embedManifest takes a parent ingredient only for an upload, never for ${CREATED_ACTION}`);
  }

  const mimeType = sniffMimeType(bytes);

  let intent: SigningJob["intent"];
  const before: SigningAssertion[] = [];
  if (created) {
    const sourceType = opts.digitalSourceType ?? AI_SOURCE_TYPE;
    intent = { create: sourceType };
    before.push({ label: "c2pa.actions", data: { actions: [{ action: CREATED_ACTION, digitalSourceType: sourceType }] } });
  } else {
    intent = "edit";
    // Before the parent and its redactions: the library files every c2pa.redacted action into the
    // actions assertion that exists at that moment, and would otherwise start a second one.
    if (opts.action !== OPENED_ACTION) {
      before.push({ label: "c2pa.actions", data: { actions: [{ action: opts.action }] } });
    }
  }
  const after: SigningAssertion[] = [{ label: SOFT_BINDING_LABEL, data: softBindingAssertion(opts.softBinding) }];
  const training = trainingAssertion(opts.training);
  if (training !== undefined) {
    after.push({ label: TRAINING_ASSERTION_LABEL, data: training });
  }

  // Copies of exactly these bytes, handed over rather than cloned: a Buffer can be a view into a
  // much larger allocation, and cloning a view clones all of it.
  const job: SigningJob = {
    bytes: new Uint8Array(bytes),
    mimeType,
    definition: { claim_generator_info: [{ name: opts.claimGenerator }], title: opts.title, format: mimeType },
    // The builder reads the parent ingredient, and a parent that still carries its XMP can name a
    // remote manifest, so it gets the same no-fetch settings as every read.
    settings: READER_SETTINGS,
    intent,
    before,
    ...(opts.parent === undefined
      ? {}
      : {
          parent: {
            bytes: new Uint8Array(opts.parent.bytes),
            mimeType: sniffMimeType(opts.parent.bytes),
            ingredient: JSON.stringify({ title: opts.title, relationship: "parentOf" }),
            redactions: [...opts.parent.redactions],
            reason: PII_REASON,
          },
        }),
    after,
    identity: signingIdentity(),
    readLimitMs: READ_MANIFEST_TIMEOUT_MS,
  };
  return await signOffThread(job);
}

/**
 * How long one signing may take on the worker. Far past the 0.9 seconds a 22 MB JPEG measured, so
 * only a stuck worker meets it.
 */
const SIGN_TIMEOUT_MS = 30_000;

/** The compiled service runs signingWorker.js; the tests and tsx run the .ts beside this file. */
const SIGNING_WORKER_URL = new URL(
  import.meta.url.endsWith(".ts") ? "./signingWorker.ts" : "./signingWorker.js",
  import.meta.url,
);

interface SigningRequest {
  job: SigningJob;
  resolve: (signed: Buffer) => void;
  reject: (error: Error) => void;
}

const signingLine: SigningRequest[] = [];
let signingWorker: Worker | undefined;
let signingBusy = false;

/**
 * Signs on the one signing worker, in the order the requests came. One worker signs one file at a
 * time, which is the throughput the main thread gave before, without the stall.
 */
function signOffThread(job: SigningJob): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    signingLine.push({ job, resolve, reject });
    signNext();
  });
}

function startSigningWorker(): Worker {
  const worker = new Worker(SIGNING_WORKER_URL);
  // An idle worker that fails is seen through its exit, which clears it so the next file gets a
  // fresh one. Without a listener here, that failure would be thrown on this thread instead.
  worker.on("error", () => undefined);
  worker.once("exit", () => {
    if (signingWorker === worker) {
      signingWorker = undefined;
    }
  });
  return worker;
}

/**
 * Hands the next file in line to the worker. The library's refusal comes back as the class the
 * main thread always threw for it. A worker that crashes, stops or runs past SIGN_TIMEOUT_MS is
 * thrown away and the file is answered SignerUnavailable: that is this host failing, not the file,
 * so a caller must not fall back to pinning it unsigned.
 */
function signNext(): void {
  if (signingBusy) {
    return;
  }
  const request = signingLine.shift();
  if (request === undefined) {
    return;
  }
  signingBusy = true;
  const worker = signingWorker ?? startSigningWorker();
  signingWorker = worker;

  let settled = false;
  const finish = (outcome: { signed: Buffer } | { error: Error }, broken: boolean): void => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    worker.off("message", onMessage);
    worker.off("error", onError);
    worker.off("exit", onExit);
    signingBusy = false;
    if (broken) {
      if (signingWorker === worker) {
        signingWorker = undefined;
      }
      void worker.terminate();
    } else {
      // An idle worker must not keep a script or a test process alive on its own.
      worker.unref();
    }
    if ("signed" in outcome) {
      request.resolve(outcome.signed);
    } else {
      request.reject(outcome.error);
    }
    signNext();
  };
  const onMessage = (answer: SigningAnswer): void => {
    finish(
      "signed" in answer
        ? { signed: Buffer.from(answer.signed.buffer, answer.signed.byteOffset, answer.signed.byteLength) }
        : { error: signingFailure(answer) },
      false,
    );
  };
  const onError = (error: Error): void =>
    finish({ error: new SignerUnavailable(`the signing worker crashed: ${error.message}`, { cause: error }) }, true);
  const onExit = (code: number): void =>
    finish({ error: new SignerUnavailable(`the signing worker stopped with code ${code}`) }, true);
  const timer = setTimeout(
    () => finish({ error: new SignerUnavailable(`signing took longer than ${SIGN_TIMEOUT_MS} ms`) }, true),
    SIGN_TIMEOUT_MS,
  );

  worker.on("message", onMessage);
  worker.on("error", onError);
  worker.on("exit", onExit);
  worker.ref();
  const { job } = request;
  worker.postMessage(job, job.parent === undefined ? [job.bytes.buffer] : [job.bytes.buffer, job.parent.bytes.buffer]);
}

function signingFailure(answer: Exclude<SigningAnswer, { signed: Uint8Array }>): Error {
  if (answer.kind === "refused") {
    return new SignerRefusedFile(answer.error);
  }
  if (answer.kind === "unavailable") {
    return new SignerUnavailable(answer.error);
  }
  return new Error(answer.error);
}

/** The work's own answer, or a rejection once READ_MANIFEST_TIMEOUT_MS has passed. */
async function withinReadLimit<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`the C2PA read was still running after ${READ_MANIFEST_TIMEOUT_MS} ms`)),
      READ_MANIFEST_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([work, limit]);
  } finally {
    clearTimeout(timer);
  }
}

/** Whether a camera's own record came through into Moolam's manifest. */
export type CameraRecord = "kept" | "dropped";

/**
 * What an upload's own C2PA store means for signing it: nothing, a store that cannot be used, or
 * a store to keep as the parent ingredient.
 */
export type CameraRecordPlan =
  | { kind: "none" }
  | { kind: "unusable"; why: string }
  | {
      kind: "store";
      /** The JUMBF URI of every assertion and thumbnail to redact, across every manifest in the store. */
      redactions: string[];
      /** Every text value the store holds under a location or serial key: none may reach the signed file. */
      secrets: string[];
    };

/** The C2PA standard's reason for a redaction made because the assertion holds personal information. */
const PII_REASON = "c2pa.PII.present";

/** Assertions whose whole purpose is to describe the capture: the camera, its settings, the place. */
const CAPTURE_METADATA_LABELS = ["stds.exif", "stds.iptc", "c2pa.metadata", "cawg.metadata"];

/**
 * What the standard does not allow to be redacted, and what the record is kept for: the actions,
 * the hard bindings and the ingredients. A location or serial inside one of these cannot be taken
 * out, so it survives into the signed bytes and the read back after signing drops the record.
 */
const NEVER_REDACTED = ["c2pa.actions", "c2pa.hash.", "c2pa.ingredient"];

/**
 * A key that names a place or a unit: a GPS or geo tag, a location, a city, a country or a region,
 * an address, a serial number. It is a rule over the key's name rather than a list of every tag a
 * camera writes, so a vendor's own "vendor:LensSerial" or "geoPoint" is caught too. It says nothing
 * about a value stored under an innocent key; that is what the byte check after signing is for.
 */
const LOCATION_OR_SERIAL_KEY = /gps|geo|locat|latitude|longitude|altitude|serial|city|country|province|region|address|(^|[:.])state$/i;

/** Labels as the library reports them, which go into a JUMBF URI: anything else stops the record. */
const SAFE_LABEL = /^[A-Za-z0-9._:-]{1,128}$/;

/** Shorter values would match unrelated bytes in the picture by chance and drop a clean record. */
const MIN_SECRET_LENGTH = 4;

/**
 * Caps on what one upload's store may ask of this service. A camera writes one manifest with a
 * handful of assertions; a store past these is not a camera's, and it is dropped rather than walked.
 */
const MAX_RECORD_MANIFESTS = 16;
const MAX_REDACTIONS = 64;
const MAX_THUMBNAILS = 32;
const MAX_SECRETS = 256;
const MAX_DATA_DEPTH = 32;

/**
 * Reads the C2PA store an upload arrived with, with the no-fetch settings and the time limit every
 * read here gets, and plans its redaction.
 *
 * In every manifest of the store, an assertion is redacted when it is capture metadata (EXIF, IPTC,
 * c2pa.metadata, cawg.metadata), when any key in its data names a place or a serial, or when its
 * data cannot be looked into at all. A thumbnail is redacted when it carries EXIF, XMP or IPTC, or
 * cannot be decoded. Actions, hard bindings and ingredients are never redacted.
 *
 * Never throws. "none" for a file with no store, including one that only names a remote manifest,
 * which is never fetched. "unusable" for a store the library cannot read, a JPEG box that may be a
 * damaged store, a label that cannot go into a URI, and a store past the caps above. "store"
 * otherwise, with the redactions to make and the values that must not survive them.
 */
export async function cameraRecordOf(upload: Buffer): Promise<CameraRecordPlan> {
  let reader: Reader | null;
  try {
    reader = await withinReadLimit(Reader.fromAsset({ buffer: upload, mimeType: sniffMimeType(upload) }, READER_SETTINGS));
  } catch (error) {
    return noStoreOr(upload, `the upload's C2PA store could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (reader === null || reader.getActive() === undefined) {
    return noStoreOr(upload, "the upload carries a JUMBF box the C2PA library could not read as a store");
  }

  const manifests = Object.entries(reader.json().manifests ?? {});
  if (manifests.length > MAX_RECORD_MANIFESTS) {
    return unusable(`the upload's store holds ${manifests.length} manifests, over the ${MAX_RECORD_MANIFESTS} a camera record may`);
  }
  const redactions = new Set<string>();
  const secrets = new Set<string>();
  for (const [label, manifest] of manifests) {
    if (!SAFE_LABEL.test(label)) {
      return unusable("a manifest label in the upload's store cannot be named in a redaction");
    }
    for (const assertion of manifest.assertions ?? []) {
      if (!SAFE_LABEL.test(assertion.label)) {
        return unusable("an assertion label in the upload's store cannot be named in a redaction");
      }
      const found = placesAndSerials(assertion.data);
      for (const value of found.values) {
        if (value.length >= MIN_SECRET_LENGTH) {
          secrets.add(value);
        }
      }
      if (neverRedacted(assertion.label)) {
        continue;
      }
      const inspectable = assertion.data !== null && typeof assertion.data === "object";
      if (isCaptureMetadata(assertion.label) || found.hit || !inspectable) {
        const instance = typeof assertion.instance === "number" && assertion.instance > 0 ? `__${assertion.instance}` : "";
        redactions.add(`self#jumbf=/c2pa/${label}/c2pa.assertions/${assertion.label}${instance}`);
      }
    }
  }

  const thumbnails = thumbnailsIn(manifests.map(([, manifest]) => manifest));
  if (thumbnails.length > MAX_THUMBNAILS) {
    return unusable(`the upload's store holds ${thumbnails.length} thumbnails, over the ${MAX_THUMBNAILS} a camera record may`);
  }
  for (const uri of thumbnails) {
    if (await carriesMetadata(reader, uri)) {
      redactions.add(uri);
    }
  }

  if (redactions.size > MAX_REDACTIONS || secrets.size > MAX_SECRETS) {
    return unusable("the upload's store holds more to redact than a camera record does");
  }
  return { kind: "store", redactions: [...redactions], secrets: [...secrets] };
}

/** Moolam's own claim thumbnail and the parent ingredient's, on top of what the upload brought. */
const MOOLAM_THUMBNAILS = 2;

/**
 * Reads a file signed with a camera's record back, before it is handed to anyone, and says what is
 * wrong with it. Nothing is wrong when Moolam's manifest validates, it names exactly one ingredient
 * and that one is the parentOf carrying the camera's manifest, the parent reports no mismatched or
 * missing part, none of `secrets` appears anywhere in the bytes, and no thumbnail left in the store
 * carries EXIF, XMP or IPTC.
 *
 * A read back that fails is itself the fault, and the record is dropped. A read back still running
 * after READ_MANIFEST_TIMEOUT_MS says nothing about the record, only that this service was slow, so
 * it throws FingerprintFault instead: the route answers 503 service-fault and the creator retries
 * with the record, rather than losing it for good (WO-186b follow-up). The answer is for the log,
 * and says which check failed without quoting any value from the upload.
 */
export async function cameraRecordFault(signed: Buffer, secrets: readonly string[]): Promise<string | undefined> {
  if (secrets.some((secret) => signed.includes(Buffer.from(secret, "utf8")))) {
    return "a location or serial value from the upload's record is still in the signed bytes";
  }
  const late = Symbol("late");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let read: Reader | null | typeof late;
  try {
    read = await Promise.race([
      Reader.fromAsset({ buffer: signed, mimeType: sniffMimeType(signed) }, READER_SETTINGS),
      new Promise<typeof late>((resolve) => {
        timer = setTimeout(() => resolve(late), READ_MANIFEST_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    return `the signed file could not be read back: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200);
  } finally {
    clearTimeout(timer);
  }
  if (read === late) {
    throw new FingerprintFault(`the C2PA reader was still reading back the signed file after ${READ_MANIFEST_TIMEOUT_MS} ms`);
  }
  const reader = read;
  const active = reader?.getActive();
  if (reader === null || active === undefined) {
    return "the signed file carries no manifest";
  }
  const store = reader.json();
  if (store.validation_state !== "Valid" && store.validation_state !== "Trusted") {
    return `Moolam's manifest does not validate: ${failureCodes(store).join(", ")}`;
  }
  const ingredients = active.ingredients ?? [];
  const parent = ingredients[0];
  if (ingredients.length !== 1 || parent?.relationship !== "parentOf" || parent.active_manifest == null) {
    return "the manifest does not name the camera's record as its one parent";
  }
  const reported = [
    ...(parent.validation_results?.activeManifest?.failure ?? []),
    ...(parent.validation_status ?? []),
    ...(store.validation_results?.ingredientDeltas ?? []).flatMap((one) => one.validationDeltas?.failure ?? []),
  ];
  const broken = [...new Set(reported.map((one) => one.code).filter((code) => /mismatch|missing/i.test(code)))];
  if (broken.length > 0) {
    return `the camera's record reports ${broken.slice(0, MAX_FAILURE_CODES).join(", ")}`.slice(0, 200);
  }
  const thumbnails = thumbnailsIn(Object.values(store.manifests ?? {}));
  if (thumbnails.length > MAX_THUMBNAILS + MOOLAM_THUMBNAILS) {
    return "the signed store holds more thumbnails than were planned";
  }
  for (const uri of thumbnails) {
    if (await carriesMetadata(reader, uri)) {
      return "a thumbnail in the signed store still carries EXIF, XMP or IPTC";
    }
  }
  return undefined;
}

function unusable(why: string): CameraRecordPlan {
  return { kind: "unusable", why: why.slice(0, 200) };
}

/** "none", unless the upload's JPEG segments hold something that may be a damaged store. */
function noStoreOr(upload: Buffer, why: string): CameraRecordPlan {
  return mayHoldStore(jumbfPackets(upload)) ? unusable(why) : { kind: "none" };
}

function neverRedacted(label: string): boolean {
  return NEVER_REDACTED.some((prefix) => label.startsWith(prefix));
}

function isCaptureMetadata(label: string): boolean {
  return CAPTURE_METADATA_LABELS.some((name) => label === name || label.startsWith(`${name}.`));
}

/**
 * Whether any key in the data names a place or a serial, and every string held under such a key,
 * however deeply. Data nested past MAX_DATA_DEPTH counts as a hit, since it was not looked into.
 */
function placesAndSerials(data: unknown): { hit: boolean; values: string[] } {
  const values: string[] = [];
  let hit = false;
  const visit = (node: unknown, under: boolean, depth: number): void => {
    if (depth > MAX_DATA_DEPTH) {
      hit = true;
    } else if (typeof node === "string") {
      if (under) values.push(node);
    } else if (Array.isArray(node)) {
      for (const one of node) visit(one, under, depth + 1);
    } else if (node !== null && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        const named = LOCATION_OR_SERIAL_KEY.test(key);
        hit ||= named;
        visit(value, under || named, depth + 1);
      }
    }
  };
  visit(data, false, 0);
  return { hit, values };
}

type StoreManifest = NonNullable<ReturnType<Reader["getActive"]>>;

/** Every thumbnail the manifests and their ingredients point at inside this store, once each. */
function thumbnailsIn(manifests: readonly StoreManifest[]): string[] {
  const uris = new Set<string>();
  for (const manifest of manifests) {
    for (const ref of [manifest.thumbnail, ...(manifest.ingredients ?? []).map((one) => one.thumbnail)]) {
      if (ref !== null && ref !== undefined && "identifier" in ref && ref.identifier.startsWith("self#jumbf=/c2pa/")) {
        uris.add(ref.identifier);
      }
    }
  }
  return [...uris];
}

/**
 * Whether a thumbnail in the store carries EXIF, XMP or IPTC, any of which can hold a location. A
 * thumbnail that cannot be read out or decoded counts as carrying it.
 */
async function carriesMetadata(reader: Reader, uri: string): Promise<boolean> {
  try {
    const resource = await withinReadLimit(reader.resourceToAsset(uri, { buffer: null }));
    const metadata = await sharp(resource.buffer, { limitInputPixels: MAX_IMAGE_PIXELS }).metadata();
    return metadata.exif !== undefined || metadata.xmp !== undefined || metadata.iptc !== undefined;
  } catch {
    return true;
  }
}

/**
 * Builds the c2pa.soft-binding assertion body.
 *
 * The value is handed over as an array of byte values because that is the one
 * form the C2PA library turns into a real CBOR byte string; a Uint8Array is
 * rejected outright and a base64 string is ambiguous to other readers. `pad` is
 * a required field in the spec's soft-binding-map, so a single zero byte is
 * written for it, and `scope` is left empty because the fingerprint covers the
 * whole still image rather than a region or a timespan.
 */
function softBindingAssertion(binding: { phash: bigint; blockhash: Hex }): unknown {
  if (binding.phash < 0n || binding.phash > 0xffffffffffffffffn) {
    throw new Error("embedManifest needs a phash that fits in 64 bits");
  }
  const blockhashHex = binding.blockhash.startsWith("0x") ? binding.blockhash.slice(2) : binding.blockhash;
  if (!/^[0-9a-fA-F]{64}$/.test(blockhashHex)) {
    throw new Error(`embedManifest needs a ${BLOCKHASH_BYTES} byte blockhash prefixed with 0x`);
  }

  const value = Buffer.alloc(PHASH_BYTES + BLOCKHASH_BYTES);
  value.writeBigUInt64BE(binding.phash, 0);
  Buffer.from(blockhashHex, "hex").copy(value, PHASH_BYTES);

  return {
    alg: SOFT_BINDING_ALG,
    pad: [0],
    blocks: [{ scope: {}, value: [...value] }],
  };
}

/** The label the C2PA specification gives the description box of the manifest store's superbox. */
const C2PA_STORE_LABEL = "c2pa";

/** One JUMBF packet from an APP11 segment, as JPEG XT splits a box across segments. */
export interface JumbfPacket {
  /** The box instance: every packet of one box carries the same number. */
  instance: number;
  /** 1 for the packet that opens the box, counting up from there. */
  packet: number;
  /** The label of the box's description box, read from packet 1 only, when it carries one. */
  label?: string;
  /** The box bytes this packet contributes, after its own packet header. */
  payload: Buffer;
}

/**
 * Reads one APP11 segment, the bytes after its length field, as a JUMBF packet: a two byte "JP"
 * tag, the box instance, the packet number, then the box. Only packet 1 carries the box's own
 * header, so later packets repeat an eight byte box header before their payload. The label comes
 * from the jumd box that opens the superbox in packet 1.
 *
 * This is the one reading of JUMBF segments in the service: the manifest hash covers the packets it
 * says belong to the C2PA store, and whether an upload holds a store, or something that may be one,
 * is read from the same packets. The byte path in prepare.ts keeps no APP11 segment of the upload
 * at all: a camera's own record travels only as the redacted parent ingredient of Moolam's manifest.
 *
 * Returns null for a segment that is not a JUMBF packet or too short to hold its header. Every
 * length is checked against the segment, and a label with no terminating zero byte is no label.
 */
export function jumbfPacket(segment: Buffer): JumbfPacket | null {
  if (segment.length < 8 || segment.subarray(0, 2).toString("latin1") !== "JP") {
    return null;
  }
  const instance = segment.readUInt16BE(2);
  const packet = segment.readUInt32BE(4);
  const header = packet === 1 ? 8 : 16;
  if (segment.length < header) {
    return null;
  }
  const payload = segment.subarray(header);
  return packet === 1 ? { instance, packet, label: superboxLabel(payload), payload } : { instance, packet, payload };
}

/** The label of a jumb superbox's opening jumd box, or undefined when it has none this can read. */
function superboxLabel(box: Buffer): string | undefined {
  const outer = boxHeader(box, 0);
  if (outer === null || outer.type !== "jumb") {
    return undefined;
  }
  const inner = boxHeader(box, outer.size);
  if (inner === null || inner.type !== "jumd") {
    return undefined;
  }
  // The description box: a 16 byte content type, one byte of toggles, then the label when the
  // label toggle (0x02) is set, UTF-8 ending in a zero byte.
  const toggles = outer.size + inner.size + 16;
  if (toggles >= box.length || ((box[toggles] as number) & 0x02) === 0) {
    return undefined;
  }
  const end = box.indexOf(0x00, toggles + 1);
  return end === -1 ? undefined : box.subarray(toggles + 1, end).toString("utf8");
}

/** A box header at `offset`: its type and how many bytes the header takes, 16 with an extended length. */
function boxHeader(box: Buffer, offset: number): { type: string; size: number } | null {
  if (offset + 8 > box.length) {
    return null;
  }
  const size = box.readUInt32BE(offset) === 1 ? 16 : 8;
  return offset + size > box.length ? null : { type: box.subarray(offset + 4, offset + 8).toString("latin1"), size };
}

/**
 * Which box instance is the C2PA manifest store: the first instance, in file order, whose packet 1
 * is a superbox labelled "c2pa". Undefined when no packet says so.
 */
export function c2paStoreInstance(packets: readonly JumbfPacket[]): number | undefined {
  return packets.find((one) => one.packet === 1 && one.label === C2PA_STORE_LABEL)?.instance;
}

/**
 * Pulls the raw C2PA manifest store out of a JPEG by reassembling the APP11
 * segments of its one box instance, so the store can be hashed exactly as it
 * sits in the file. Any other JUMBF box in the file, a 360 degree description
 * or another tool's data, is left out: the chain records the hash of the C2PA
 * store and nothing beside it (review pass 6, intake 5). Returns null for any
 * other container, and for a JPEG with no box labelled as the C2PA store.
 *
 * The file is the caller's, so every length in it is checked against the
 * buffer before it is used. A segment that runs past the end stops the walk,
 * and a JP segment too short to hold its packet header is skipped, which is
 * what the C2PA library itself does with one.
 */
function extractManifestStore(bytes: Buffer): Buffer | null {
  const packets = jumbfPackets(bytes);
  const store = c2paStoreInstance(packets);
  if (store === undefined) {
    return null;
  }
  return Buffer.concat(packets.filter((one) => one.instance === store).map((one) => one.payload));
}

/**
 * Whether these packets hold a C2PA store or something that may be one: a box labelled "c2pa", or
 * a box whose label cannot be read, as a damaged store's cannot. A file whose every box names
 * itself as something else holds none.
 */
function mayHoldStore(packets: readonly JumbfPacket[]): boolean {
  if (c2paStoreInstance(packets) !== undefined) {
    return true;
  }
  const named = new Set(packets.filter((one) => one.packet === 1 && one.label !== undefined).map((one) => one.instance));
  return packets.some((one) => !named.has(one.instance));
}

/** Every JUMBF packet in a JPEG's APP11 segments before its first scan, in file order. Empty for any other container. */
function jumbfPackets(bytes: Buffer): JumbfPacket[] {
  if (sniffMimeType(bytes) !== "image/jpeg") {
    return [];
  }

  const packets: JumbfPacket[] = [];
  let offset = 2;
  while (offset < bytes.length - 1) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1] as number;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    if (marker === 0xda || offset + 4 > bytes.length) {
      break;
    }
    const length = bytes.readUInt16BE(offset + 2);
    const end = offset + 2 + length;
    if (length < 2 || end > bytes.length) {
      break;
    }
    if (marker === 0xeb) {
      const packet = jumbfPacket(bytes.subarray(offset + 4, end));
      if (packet !== null) {
        packets.push(packet);
      }
    }
    offset = end;
  }
  return packets;
}

function sniffMimeType(bytes: Buffer): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes.subarray(1, 4).toString("latin1") === "PNG") {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    bytes.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  return "application/octet-stream";
}

/**
 * Resolves the signing identity from the two validated environment values.
 *
 * The certificate and the key are one identity, so they are taken together: set
 * both to sign with your own, or neither to sign with the throwaway development
 * chain. Setting one alone used to pair a real certificate with the development
 * key, which produces a manifest that no reader can verify, so it now stops the
 * caller instead.
 *
 * With nothing set, a throwaway ES256 chain is generated once into
 * test-assets/certs, which is gitignored and never leaves this machine. The
 * chain has to be generated because the npm package of @contentauth/c2pa-node
 * ships only dist, scripts and src, so the test certificates that live in its
 * repository are not installed with it.
 *
 * The leaf, the first certificate in the file, must be inside its validity
 * window now: the C2PA library refuses to sign with one outside it, and a host
 * whose every signing fails that way must not look ready (review pass 10, V93).
 * The key must be the leaf's own: the library signs with any key it is handed,
 * and every manifest signed with the wrong one fails its signature check (V94).
 *
 * Throws SignerUnavailable when only one of the two paths is set, when a path is
 * set and no file is there, when openssl is missing, when the leaf cannot be
 * read or is outside its validity window, and when the key is not the leaf's.
 */
export function loadSigner(
  paths: { certPath?: string; keyPath?: string } = {
    certPath: env.MOOLAM_C2PA_CERT_PATH,
    keyPath: env.MOOLAM_C2PA_KEY_PATH,
  },
): LocalSigner {
  const identity = signingIdentity(paths);
  const cert = readFileSync(identity.certPath);
  const key = readFileSync(identity.keyPath);
  const problem = credentialProblem(cert, key, new Date());
  if (problem !== undefined) {
    throw new SignerUnavailable(problem);
  }
  return LocalSigner.newSigner(cert, key, "es256");
}

/**
 * Why this certificate and key cannot sign at `now`, or undefined when they can. The leaf is the
 * first certificate in the file, which is where a C2PA chain puts it, and the key has to be its own.
 * signingWorker.ts makes the same checks, in the same words, since it may not import this file.
 */
function credentialProblem(cert: Buffer, key: Buffer, now: Date): string | undefined {
  let leaf: X509Certificate;
  try {
    leaf = new X509Certificate(cert);
  } catch {
    return "the signing certificate could not be read as an X.509 certificate";
  }
  if (!isLeafKey(leaf, key)) {
    return "the signing key is not the key of the signing certificate";
  }
  if (now < leaf.validFromDate) {
    return `the signing certificate is not valid until ${leaf.validFromDate.toISOString()}`;
  }
  if (now > leaf.validToDate) {
    return `the signing certificate expired at ${leaf.validToDate.toISOString()}`;
  }
  return undefined;
}

/** Whether `key` is the private half of the leaf's public key. A key that cannot be read is not. */
function isLeafKey(leaf: X509Certificate, key: Buffer): boolean {
  try {
    return leaf.checkPrivateKey(createPrivateKey(key));
  } catch {
    return false;
  }
}

/**
 * Where the certificate and the key loadSigner would use are on disk, by the same rules, so the
 * signing worker loads the identity this thread checked. Throws what loadSigner throws for them.
 */
function signingIdentity(
  paths: { certPath?: string; keyPath?: string } = {
    certPath: env.MOOLAM_C2PA_CERT_PATH,
    keyPath: env.MOOLAM_C2PA_KEY_PATH,
  },
): { certPath: string; keyPath: string } {
  const { certPath, keyPath } = paths;
  if ((certPath === undefined) !== (keyPath === undefined)) {
    throw new SignerUnavailable(
      "MOOLAM_C2PA_CERT_PATH and MOOLAM_C2PA_KEY_PATH go together: set both to sign with your own identity, or neither to use the development one",
    );
  }

  if (certPath !== undefined && keyPath !== undefined) {
    if (!existsSync(certPath) || !existsSync(keyPath)) {
      throw new SignerUnavailable(`no signing certificate or key found at ${certPath} and ${keyPath}`);
    }
    return { certPath, keyPath };
  }

  const devCert = path.join(devCertDir, "chain.cert.pem");
  const devKey = path.join(devCertDir, "signer.key.pem");
  if (!existsSync(devCert) || !existsSync(devKey)) {
    generateDevSigningIdentity();
  }
  return { certPath: devCert, keyPath: devKey };
}

/**
 * Checks at boot that this host can sign, so a missing certificate stops the service from mounting
 * instead of letting every request answer 200 with an unsigned picture in it.
 *
 * Throws SignerUnavailable, with the same message loadSigner gives, and nothing else.
 */
export async function ensureSigner(): Promise<void> {
  try {
    loadSigner();
  } catch (error) {
    if (error instanceof SignerUnavailable) throw error;
    throw new SignerUnavailable(error instanceof Error ? error.message : String(error), { cause: error });
  }
}

/**
 * Builds a two certificate ES256 chain with openssl. C2PA rejects a plain
 * self-signed leaf: the signing certificate must not be a certificate
 * authority, must carry digitalSignature key usage, must carry an extended key
 * usage such as email protection, and must be issued by something other than
 * itself.
 */
function generateDevSigningIdentity(): void {
  mkdirSync(devCertDir, { recursive: true });

  const configPath = path.join(devCertDir, "openssl.cnf");
  writeFileSync(
    configPath,
    [
      "[req]",
      "distinguished_name = dn",
      "prompt = no",
      "[dn]",
      "CN = Moolam Development Root",
      "O = Moolam",
      "C = US",
      "[v3_ca]",
      "basicConstraints = critical, CA:TRUE, pathlen:0",
      "keyUsage = critical, keyCertSign, cRLSign",
      "subjectKeyIdentifier = hash",
      "[v3_leaf]",
      "basicConstraints = critical, CA:FALSE",
      "keyUsage = critical, digitalSignature",
      "extendedKeyUsage = emailProtection",
      "subjectKeyIdentifier = hash",
      "authorityKeyIdentifier = keyid:always",
      "",
    ].join("\n"),
  );

  const leafConfigPath = path.join(devCertDir, "openssl-leaf.cnf");
  writeFileSync(
    leafConfigPath,
    [
      "[req]",
      "distinguished_name = dn",
      "prompt = no",
      "[dn]",
      "CN = Moolam Development Signer",
      "O = Moolam",
      "C = US",
      "",
    ].join("\n"),
  );

  const rootKey = path.join(devCertDir, "root.key.pem");
  const rootCert = path.join(devCertDir, "root.cert.pem");
  const signerKey = path.join(devCertDir, "signer.key.pem");
  const signerCsr = path.join(devCertDir, "signer.csr");
  const signerCert = path.join(devCertDir, "signer.cert.pem");
  const chainCert = path.join(devCertDir, "chain.cert.pem");

  const openssl = (args: string[]): void => {
    try {
      execFileSync("openssl", args, { stdio: "pipe" });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new SignerUnavailable(`openssl is needed to make the development signing certificate: ${detail}`);
    }
  };

  openssl(["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", rootKey]);
  openssl([
    "req", "-new", "-x509", "-key", rootKey, "-sha256", "-days", "3650",
    "-out", rootCert, "-config", configPath, "-extensions", "v3_ca",
  ]);
  openssl(["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", signerKey]);
  openssl(["req", "-new", "-key", signerKey, "-out", signerCsr, "-config", leafConfigPath]);
  openssl([
    "x509", "-req", "-in", signerCsr, "-CA", rootCert, "-CAkey", rootKey, "-CAcreateserial",
    "-out", signerCert, "-days", "365", "-sha256", "-extfile", configPath, "-extensions", "v3_leaf",
  ]);

  writeFileSync(chainCert, Buffer.concat([readFileSync(signerCert), readFileSync(rootCert)]));
}
