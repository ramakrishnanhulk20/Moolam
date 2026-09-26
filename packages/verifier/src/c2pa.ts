import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Builder, LocalSigner, Reader } from "@contentauth/c2pa-node";
import { TRAINING_ASSERTION_LABEL, trainingAssertion, type TrainingConsent } from "./consent.js";
import { env } from "./env.js";
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
  /** The library's failure codes for an invalid manifest, such as "assertion.dataHash.mismatch". */
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
 * points, only one of the two paths is set, or openssl is not installed to make the development
 * identity. No file can get past it, so a caller has to stop rather than quietly pin unsigned
 * pictures for everyone.
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

/**
 * Reads any C2PA manifest embedded in an image, and whether it validates.
 *
 * Never throws. A file with no manifest, or empty bytes, is present false. A
 * file the library cannot parse, or a JPEG that still carries C2PA segments the
 * library could not read, is present false with validation "unreadable", so a
 * damaged manifest costs the caller the manifest and never the match. A manifest
 * that parses is present, with the library's own validation state: anything but
 * a clean pass reads as invalid. Checking the signing certificate against a
 * trust list is deliberately not done here: the spike signs with a throwaway
 * certificate, so every manifest it reads back is reported as untrusted.
 */
export async function readManifest(bytes: Buffer): Promise<ManifestSummary> {
  if (bytes.length === 0) {
    return { present: false };
  }
  try {
    return await summarise(bytes);
  } catch {
    return manifestUnreadable();
  }
}

async function summarise(bytes: Buffer): Promise<ManifestSummary> {
  const reader = await Reader.fromAsset({ buffer: bytes, mimeType: sniffMimeType(bytes) });
  const active = reader?.getActive();
  if (reader === null || active === undefined) {
    // The library answers "nothing here" for a store whose boxes it cannot parse, so the segments
    // themselves are what tell a broken manifest apart from a file that never had one.
    return extractManifestStore(bytes) === null ? { present: false } : manifestUnreadable();
  }

  const store = reader.json();
  const state = store.validation_state;
  const validation = state === "Valid" || state === "Trusted" ? "valid" : "invalid";

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
    validation,
    ...(validation === "invalid" ? { failures: failureCodes(store) } : {}),
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

/**
 * The failure codes the library reported for the active manifest, falling back to its flat status
 * list. Each code is passed on to callers, so only short dotted names are kept and the list is
 * capped: a crafted manifest cannot use this field to smuggle text into the answer.
 */
function failureCodes(store: ReturnType<Reader["json"]>): string[] {
  const entries = store.validation_results?.activeManifest?.failure ?? store.validation_status ?? [];
  const codes = entries
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
 * Throws when the buffer is empty, when the options are incomplete, when a
 * source type is given with any action but "c2pa.created", when the
 * fingerprint is the wrong size, when the training statement is not one this
 * service may write, SignerUnavailable when no signing identity can be
 * resolved, and SignerRefusedFile when the C2PA library rejects this container.
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

  const mimeType = sniffMimeType(bytes);

  const builder = Builder.withJson({
    claim_generator_info: [{ name: opts.claimGenerator }],
    title: opts.title,
    format: mimeType,
  });
  if (created) {
    const sourceType = opts.digitalSourceType ?? AI_SOURCE_TYPE;
    builder.setIntent({ create: sourceType });
    builder.addAssertion("c2pa.actions", { actions: [{ action: CREATED_ACTION, digitalSourceType: sourceType }] }, "Cbor");
  } else {
    builder.setIntent("edit");
    if (opts.action !== OPENED_ACTION) {
      builder.addAssertion("c2pa.actions", { actions: [{ action: opts.action }] }, "Cbor");
    }
  }
  builder.addAssertion(SOFT_BINDING_LABEL, softBindingAssertion(opts.softBinding), "Cbor");
  const training = trainingAssertion(opts.training);
  if (training !== undefined) {
    builder.addAssertion(TRAINING_ASSERTION_LABEL, training, "Cbor");
  }

  const signer = loadSigner();
  const destination: { buffer: Buffer | null } = { buffer: null };
  try {
    builder.sign(signer, { buffer: bytes, mimeType }, destination);
  } catch (error) {
    throw new SignerRefusedFile(error instanceof Error ? error.message : String(error), { cause: error });
  }

  if (destination.buffer === null) {
    throw new SignerRefusedFile("embedManifest signed the image but got no bytes back");
  }
  return destination.buffer;
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

/**
 * Pulls the raw C2PA manifest store out of a JPEG by reassembling its APP11
 * segments, so the store can be hashed exactly as it sits in the file. Returns
 * null for any other container, which is all the spike needs.
 *
 * The file is the caller's, so every length in it is checked against the
 * buffer before it is used. A segment that runs past the end stops the walk,
 * and a JP segment too short to hold its packet header is skipped, which is
 * what the C2PA library itself does with one.
 */
function extractManifestStore(bytes: Buffer): Buffer | null {
  if (sniffMimeType(bytes) !== "image/jpeg") {
    return null;
  }

  const chunks: Buffer[] = [];
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
      const segment = bytes.subarray(offset + 4, end);
      // Layout for JUMBF inside JPEG: a two byte JP tag, the box instance, the
      // packet number, then the box itself. Only packet one carries the box
      // header, so later packets contribute their payload alone.
      if (segment.length >= 8 && segment.subarray(0, 2).toString("latin1") === "JP") {
        const packet = segment.readUInt32BE(4);
        const header = packet === 1 ? 8 : 16;
        if (segment.length >= header) {
          chunks.push(segment.subarray(header));
        }
      }
    }
    offset = end;
  }

  return chunks.length === 0 ? null : Buffer.concat(chunks);
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
 * Throws SignerUnavailable when only one of the two paths is set, when a path is
 * set and no file is there, and when openssl is missing.
 */
export function loadSigner(
  paths: { certPath?: string; keyPath?: string } = {
    certPath: env.MOOLAM_C2PA_CERT_PATH,
    keyPath: env.MOOLAM_C2PA_KEY_PATH,
  },
): LocalSigner {
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
    return LocalSigner.newSigner(readFileSync(certPath), readFileSync(keyPath), "es256");
  }

  const devCert = path.join(devCertDir, "chain.cert.pem");
  const devKey = path.join(devCertDir, "signer.key.pem");
  if (!existsSync(devCert) || !existsSync(devKey)) {
    generateDevSigningIdentity();
  }
  return LocalSigner.newSigner(readFileSync(devCert), readFileSync(devKey), "es256");
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
