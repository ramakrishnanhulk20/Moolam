import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Signing identities with a validity window a test chooses, made with openssl in a temporary folder
// for the length of one test file and removed after it. Nothing here is kept in the repository.

export interface SigningIdentity {
  /** The leaf then the root, the shape MOOLAM_C2PA_CERT_PATH takes. */
  certPath: string;
  /** The leaf's own key. */
  keyPath: string;
  /** A second P-256 key that is not the leaf's. */
  otherKeyPath: string;
  notBefore: Date;
  notAfter: Date;
}

const made: string[] = [];

/**
 * An ES256 root and a leaf valid from `notBefore` to `notAfter`, with the same extensions the
 * development identity carries, so the C2PA library takes it as a signer while it is in its window.
 * openssl writes the window in whole seconds, so both ends are rounded down to the second.
 */
export function signingIdentity(notBefore: Date, notAfter: Date): SigningIdentity {
  const dir = mkdtempSync(path.join(tmpdir(), "moolam-identity-"));
  made.push(dir);
  const config = path.join(dir, "openssl.cnf");
  writeFileSync(
    config,
    [
      "[req]",
      "distinguished_name = dn",
      "prompt = no",
      "[dn]",
      "CN = Moolam Test Signer",
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
  const file = (name: string): string => path.join(dir, name);
  const openssl = (args: string[]): void => {
    execFileSync("openssl", args, { stdio: "pipe" });
  };
  const newKey = (out: string): void =>
    openssl(["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", out]);

  newKey(file("root.key.pem"));
  openssl([
    "req", "-new", "-x509", "-key", file("root.key.pem"), "-sha256", "-days", "3650",
    "-out", file("root.cert.pem"), "-config", config, "-extensions", "v3_ca",
  ]);
  newKey(file("signer.key.pem"));
  newKey(file("other.key.pem"));
  openssl(["req", "-new", "-key", file("signer.key.pem"), "-out", file("signer.csr"), "-config", config]);
  openssl([
    "x509", "-req", "-in", file("signer.csr"), "-CA", file("root.cert.pem"), "-CAkey", file("root.key.pem"),
    "-CAcreateserial", "-out", file("signer.cert.pem"), "-not_before", stamp(notBefore), "-not_after", stamp(notAfter),
    "-sha256", "-extfile", config, "-extensions", "v3_leaf",
  ]);
  writeFileSync(file("chain.cert.pem"), Buffer.concat([readFileSync(file("signer.cert.pem")), readFileSync(file("root.cert.pem"))]));

  return {
    certPath: file("chain.cert.pem"),
    keyPath: file("signer.key.pem"),
    otherKeyPath: file("other.key.pem"),
    notBefore: new Date(Math.floor(notBefore.getTime() / 1000) * 1000),
    notAfter: new Date(Math.floor(notAfter.getTime() / 1000) * 1000),
  };
}

/** openssl's YYYYMMDDHHMMSSZ form of a moment, in UTC. */
function stamp(moment: Date): string {
  return `${moment.toISOString().replace(/[-:T]/g, "").slice(0, 14)}Z`;
}

/** Removes every identity this file made. */
export function removeSigningIdentities(): void {
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Resolves once `moment` has passed by `margin` milliseconds. */
export async function waitUntilPast(moment: Date, margin = 1_500): Promise<void> {
  const left = moment.getTime() + margin - Date.now();
  if (left > 0) {
    await new Promise((resolve) => setTimeout(resolve, left));
  }
}
