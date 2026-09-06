import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Builder, LocalSigner, Reader } from "@contentauth/c2pa-node";
import type { Hex } from "./fingerprint.js";

export interface ManifestSummary {
  present: boolean;
  manifestHash?: Hex;
  title?: string;
  claimGenerator?: string;
  actions?: string[];
  ingredients?: number;
}

const AI_SOURCE_TYPE = "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia";

const packageRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const devCertDir = path.join(packageRoot, "test-assets", "certs");

/**
 * Reads any C2PA manifest embedded in an image.
 *
 * Returns present false rather than throwing when the image carries no
 * manifest, when the bytes are empty, or when the container is one the C2PA
 * library cannot open. Checking the signing certificate against a trust list is
 * deliberately not done here: the spike signs with a throwaway certificate, so
 * every manifest it reads back is reported as untrusted.
 */
export async function readManifest(bytes: Buffer): Promise<ManifestSummary> {
  if (bytes.length === 0) {
    return { present: false };
  }

  let reader: Reader | null = null;
  try {
    reader = await Reader.fromAsset({ buffer: bytes, mimeType: sniffMimeType(bytes) });
  } catch {
    return { present: false };
  }
  if (reader === null) {
    return { present: false };
  }

  const active = reader.getActive();
  if (active === undefined) {
    return { present: false };
  }

  const actions = (active.assertions ?? [])
    .filter((assertion) => assertion.label?.startsWith("c2pa.actions"))
    .flatMap((assertion) => {
      const data = assertion.data as { actions?: { action?: string }[] } | undefined;
      return (data?.actions ?? []).map((entry) => entry.action).filter((name): name is string => Boolean(name));
    });

  const generator = active.claim_generator_info?.[0];
  const manifestStore = extractManifestStore(bytes);

  return {
    present: true,
    manifestHash:
      manifestStore === null ? undefined : `0x${createHash("sha256").update(manifestStore).digest("hex")}`,
    title: active.title,
    claimGenerator:
      generator === undefined ? active.claim_generator : `${generator.name} ${generator.version ?? ""}`.trim(),
    actions,
    ingredients: active.ingredients?.length ?? 0,
  };
}

/**
 * Signs a new C2PA manifest into a copy of the image and returns the signed
 * bytes. The create intent marks the image as a new work and, unless another
 * digital source type is passed, declares it AI generated.
 *
 * Throws when the buffer is empty, when the options are incomplete, when no
 * signing identity can be resolved, or when the C2PA library rejects the
 * container.
 */
export async function embedManifest(
  bytes: Buffer,
  opts: { title: string; claimGenerator: string; action: string; digitalSourceType?: string },
): Promise<Buffer> {
  if (bytes.length === 0) {
    throw new Error("embedManifest needs a non-empty image buffer");
  }
  if (opts.title.length === 0 || opts.claimGenerator.length === 0 || opts.action.length === 0) {
    throw new Error("embedManifest needs a title, a claim generator and an action");
  }

  const sourceType = opts.digitalSourceType ?? AI_SOURCE_TYPE;
  const mimeType = sniffMimeType(bytes);

  const builder = Builder.withJson({
    claim_generator_info: [{ name: opts.claimGenerator }],
    title: opts.title,
    format: mimeType,
  });
  builder.setIntent({ create: sourceType });
  builder.addAssertion("c2pa.actions", { actions: [{ action: opts.action, digitalSourceType: sourceType }] }, "Cbor");

  const signer = loadSigner();
  const destination: { buffer: Buffer | null } = { buffer: null };
  builder.sign(signer, { buffer: bytes, mimeType }, destination);

  if (destination.buffer === null) {
    throw new Error("embedManifest signed the image but got no bytes back");
  }
  return destination.buffer;
}

/**
 * Pulls the raw C2PA manifest store out of a JPEG by reassembling its APP11
 * segments, so the store can be hashed exactly as it sits in the file. Returns
 * null for any other container, which is all the spike needs.
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
    if (marker === 0xda) {
      break;
    }
    const length = bytes.readUInt16BE(offset + 2);
    if (marker === 0xeb) {
      const segment = bytes.subarray(offset + 4, offset + 2 + length);
      // Layout for JUMBF inside JPEG: a two byte JP tag, the box instance, the
      // packet number, then the box itself. Only packet one carries the box
      // header, so later packets contribute their payload alone.
      if (segment.subarray(0, 2).toString("latin1") === "JP") {
        const packet = segment.readUInt32BE(4);
        chunks.push(packet === 1 ? segment.subarray(8) : segment.subarray(16));
      }
    }
    offset += 2 + length;
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
 * Resolves the signing identity. A real deployment points the two environment
 * variables at its own certificate. With nothing set, a throwaway ES256 chain
 * is generated once into test-assets/certs, which is gitignored and never
 * leaves this machine.
 *
 * The chain has to be generated because the npm package of
 * @contentauth/c2pa-node ships only dist, scripts and src, so the test
 * certificates that live in its repository are not installed with it.
 */
function loadSigner(): LocalSigner {
  const certPath = process.env.MOOLAM_C2PA_CERT_PATH ?? path.join(devCertDir, "chain.cert.pem");
  const keyPath = process.env.MOOLAM_C2PA_KEY_PATH ?? path.join(devCertDir, "signer.key.pem");

  if (!existsSync(certPath) || !existsSync(keyPath)) {
    if (process.env.MOOLAM_C2PA_CERT_PATH !== undefined || process.env.MOOLAM_C2PA_KEY_PATH !== undefined) {
      throw new Error(`no signing certificate or key found at ${certPath} and ${keyPath}`);
    }
    generateDevSigningIdentity();
  }

  return LocalSigner.newSigner(readFileSync(certPath), readFileSync(keyPath), "es256");
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
      throw new Error(`openssl is needed to make the development signing certificate: ${detail}`);
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
