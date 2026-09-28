// Covers review pass 10 on the signing credential. V92: a manifest whose only failures are about the
// certificate that signed it, expired or untrusted, in Moolam's own manifest or in a camera
// ingredient's deltas, reads valid with the certificate's state named, while a tampered file still
// reads invalid. V93: a leaf outside its validity window is SignerUnavailable at boot, which turns the
// signing routes off, and one that expires while the service runs makes each signing fail as
// SignerUnavailable, never an unsigned file. V94: a certificate and a key that are not a pair stop the
// signer at load, and a freshly signed file whose signature does not validate is SignerUnavailable,
// never embedded. A camera's record is read back by the same rule: a kept record whose
// camera leaf expired is no fault while a tampered one is, and a photo uploaded after its camera
// leaf expired keeps its record, public and sealed, unless it was changed after capture.
// Every identity is made with openssl in a temporary folder for this run.
// Does NOT cover a trusted timestamp (Moolam signs without one), a revoked certificate, or the C2PA
// library itself refusing a credential that passed the window and pair checks, which the worker
// classifies by the library's own words and which no certificate made here provokes.

import { readFileSync } from "node:fs";
import { Builder, LocalSigner } from "@contentauth/c2pa-node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { SOFT_BINDING_ALG, SignerUnavailable, cameraRecordFault, loadSigner, readManifest, type EmbedOptions } from "../src/c2pa.js";
import { prepareOrFallback, prepareSealed } from "../src/prepare.js";
import { cameraPhoto } from "./cameraPhoto.js";
import { makeImage } from "./helpers.js";
import { segment, withSegments } from "./jpegParts.js";
import { removeSigningIdentities, signingIdentity, waitUntilPast, type SigningIdentity } from "./signingIdentity.js";

const SETTINGS = { title: "Harbour", claimGenerator: "moolam-studio/0.1.0", action: "c2pa.opened" as const };
const DAY_MS = 24 * 60 * 60 * 1000;

/** How long the short-lived leaf lasts: long enough to sign twice on a cold worker, short enough to wait out. */
const SHORT_LIFE_MS = 9_000;

/** A fresh module graph that signs with `identity`, since src/env.ts reads the paths once on load. */
async function modulesSigningWith(identity: { certPath: string; keyPath: string }) {
  vi.stubEnv("MOOLAM_C2PA_CERT_PATH", identity.certPath);
  vi.stubEnv("MOOLAM_C2PA_KEY_PATH", identity.keyPath);
  vi.resetModules();
  try {
    const c2pa = await import("../src/c2pa.js");
    const prepare = await import("../src/prepare.js");
    return { c2pa, prepare };
  } finally {
    vi.unstubAllEnvs();
  }
}

/** The same file with one bit of its picture data flipped, so its hard binding no longer matches. */
function tampered(signed: Buffer): Buffer {
  const copy = Buffer.from(signed);
  // A byte inside the scan, with no 0xFF beside it, so the flip cannot make or break a marker.
  for (let at = copy.length - 300; at > 2; at -= 1) {
    const byte = copy[at] as number;
    if (byte < 0xf0 && copy[at - 1] !== 0xff && copy[at + 1] !== 0xff) {
      copy[at] = byte ^ 0x01;
      return copy;
    }
  }
  throw new Error("no byte to flip");
}

/** A file signed straight through the library with `signer`, in the shape embedManifest writes. */
function signedDirectly(bytes: Buffer, opts: EmbedOptions, signer: LocalSigner): Buffer {
  const builder = Builder.withJson({ claim_generator_info: [{ name: opts.claimGenerator }], title: opts.title, format: "image/jpeg" });
  builder.setIntent("edit");
  const value = Buffer.alloc(40);
  value.writeBigUInt64BE(opts.softBinding.phash, 0);
  Buffer.from(opts.softBinding.blockhash.slice(2), "hex").copy(value, 8);
  builder.addAssertion("c2pa.soft-binding", { alg: SOFT_BINDING_ALG, pad: [0], blocks: [{ scope: {}, value: [...value] }] }, "Cbor");
  const destination: { buffer: Buffer | null } = { buffer: null };
  builder.sign(signer, { buffer: bytes, mimeType: "image/jpeg" }, destination);
  if (destination.buffer === null) {
    throw new Error("the library signed nothing");
  }
  return destination.buffer;
}

afterAll(() => {
  removeSigningIdentities();
});

describe("a leaf that expires after it signed", () => {
  let short: SigningIdentity;
  let shortModules: Awaited<ReturnType<typeof modulesSigningWith>>;
  let picture: Buffer;
  let signedByShort: Buffer;
  let keptRecord: Buffer;
  /** A camera photo signed by the short leaf and uploaded only after that leaf expired. */
  let lateUpload: Buffer;
  const before: Record<string, Awaited<ReturnType<typeof readManifest>>> = {};

  beforeAll(async () => {
    const now = Date.now();
    short = signingIdentity(new Date(now - 60_000), new Date(now + SHORT_LIFE_MS));
    shortModules = await modulesSigningWith(short);
    picture = await makeImage(921);

    signedByShort = await shortModules.c2pa.embedManifest(picture, {
      title: "harbour.jpg",
      claimGenerator: "moolam-studio/0.1.0",
      action: "c2pa.opened",
      softBinding: { phash: 1n, blockhash: `0x${"ab".repeat(32)}` },
    });
    // The camera signs with the short leaf; Moolam signs over it with the development identity.
    const camera = LocalSigner.newSigner(readFileSync(short.certPath), readFileSync(short.keyPath), "es256");
    const prepared = await prepareOrFallback(await cameraPhoto(922, { signer: camera }), SETTINGS);
    expect(prepared.embedded).toBe(true);
    expect(prepared.cameraRecord).toBe("kept");
    keptRecord = prepared.bytes;
    lateUpload = await cameraPhoto(923, { signer: camera });

    before.signed = await readManifest(signedByShort);
    before.kept = await readManifest(keptRecord);
    await waitUntilPast(short.notAfter);
  }, 90_000);

  it("V92: a file signed by a leaf that has since expired reads valid, and says the certificate expired", async () => {
    expect(before.signed).toMatchObject({ present: true, validation: "valid" });
    expect(before.signed).not.toHaveProperty("credential");

    const after = await readManifest(signedByShort);
    expect(after).toMatchObject({ present: true, validation: "valid", credential: "expired" });
    expect(after.failures).toContain("signingCredential.expired");
    expect(after.manifestHash).toBe(before.signed?.manifestHash);
  });

  it("V92: a tampered file still reads invalid, whether its leaf expired or not", async () => {
    const expired = await readManifest(tampered(signedByShort));
    expect(expired.validation).toBe("invalid");
    expect(expired.failures).toContain("assertion.dataHash.mismatch");
    expect(expired).not.toHaveProperty("credential");

    const fresh = await readManifest(tampered(keptRecord));
    expect(fresh.validation).toBe("invalid");
    expect(fresh.failures).toContain("assertion.dataHash.mismatch");
  });

  it("V92: a kept camera record whose camera leaf expired reads valid, and names the expiry from the ingredient", async () => {
    expect(before.kept).toMatchObject({ present: true, validation: "valid" });

    const after = await readManifest(keptRecord);
    expect(after).toMatchObject({ present: true, validation: "valid", credential: "expired" });
    expect(after.failures).toContain("signingCredential.expired");
  });

  it("keeps the record of a camera photo whose camera leaf expired before the upload, public and sealed", async () => {
    const pub = await prepareOrFallback(lateUpload, SETTINGS);
    expect(pub.embedded).toBe(true);
    expect(pub.cameraRecord).toBe("kept");
    expect(await readManifest(pub.bytes)).toMatchObject({ present: true, validation: "valid", ingredients: 1 });

    const sealed = await prepareSealed(lateUpload, SETTINGS);
    expect(sealed.embedded).toBe(true);
    expect(sealed.cameraRecord).toBe("kept");
  }, 60_000);

  it("reads back a kept record whose camera leaf expired after signing by readManifest's rule: no fault, and a tampered copy still one", async () => {
    expect(await cameraRecordFault(keptRecord, [])).toBeUndefined();

    const fault = await cameraRecordFault(tampered(keptRecord), []);
    expect(fault).toMatch(/does not validate/);
    expect(fault).toContain("assertion.dataHash.mismatch");
  }, 30_000);

  it("still drops the record of an expired camera's photo that was changed after capture", async () => {
    const touched = withSegments(lateUpload, [segment(0xfe, Buffer.from("touched after capture"))]);

    const prepared = await prepareOrFallback(touched, SETTINGS);

    expect(prepared.embedded).toBe(true);
    expect(prepared.cameraRecord).toBe("dropped");
  }, 60_000);

  it("V93: a leaf that expires between two signings makes the next one SignerUnavailable, and prepare hands back no unsigned file", async () => {
    await expect(
      shortModules.c2pa.embedManifest(picture, {
        title: "harbour.jpg",
        claimGenerator: "moolam-studio/0.1.0",
        action: "c2pa.opened",
        softBinding: { phash: 1n, blockhash: `0x${"ab".repeat(32)}` },
      }),
    ).rejects.toBeInstanceOf(shortModules.c2pa.SignerUnavailable);
    await expect(shortModules.prepare.prepareOrFallback(picture, SETTINGS)).rejects.toBeInstanceOf(
      shortModules.c2pa.SignerUnavailable,
    );
    await expect(shortModules.prepare.prepareSealed(picture, SETTINGS)).rejects.toBeInstanceOf(
      shortModules.c2pa.SignerUnavailable,
    );
  }, 60_000);
});

describe("V93: a leaf outside its validity window at boot", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("refuses an expired leaf and a leaf not yet valid as SignerUnavailable, and loads one inside its window", () => {
    const now = Date.now();
    const expired = signingIdentity(new Date(now - 2 * DAY_MS), new Date(now - DAY_MS));
    const early = signingIdentity(new Date(now + DAY_MS), new Date(now + 2 * DAY_MS));
    const current = signingIdentity(new Date(now - DAY_MS), new Date(now + DAY_MS));

    expect(() => loadSigner(expired)).toThrow(SignerUnavailable);
    expect(() => loadSigner(expired)).toThrow(/expired/);
    expect(() => loadSigner(early)).toThrow(SignerUnavailable);
    expect(() => loadSigner(early)).toThrow(/not valid until/);
    expect(loadSigner(current)).toBeDefined();
  });

  it("turns /prepare, /generate and /edit off at boot with the signer's reason, and keeps /verify on", async () => {
    const now = Date.now();
    const expired = signingIdentity(new Date(now - 2 * DAY_MS), new Date(now - DAY_MS));
    const vars = {
      GENERATOR_WALLET_ID: "",
      PINATA_JWT: "test-token-not-a-real-pinata-jwt",
      PRIVY_APP_ID: "moolamtestapp0000187",
      PRIVY_APP_SECRET: "test-app-secret-not-a-real-one",
      MOOLAM_C2PA_CERT_PATH: expired.certPath,
      MOOLAM_C2PA_KEY_PATH: expired.keyPath,
      X402_ENABLED: "false",
      EXPECT_ROUTES: "",
    };
    for (const [name, value] of Object.entries(vars)) {
      vi.stubEnv(name, value);
    }
    vi.resetModules();
    const c2pa = await import("../src/c2pa.js");
    await expect(c2pa.ensureSigner()).rejects.toThrow(/expired/);

    const { buildServer } = await import("../src/server.js");
    const app: FastifyInstance = await buildServer({
      source: { load: async () => [] },
      logger: false,
      generate: {},
      edit: {},
      checks: { registry: async () => undefined },
    });
    await app.ready();
    try {
      for (const url of ["/prepare", "/generate", "/edit"]) {
        expect((await app.inject({ method: "POST", url, payload: {} })).statusCode, url).toBe(404);
      }
      const health = (await app.inject({ method: "GET", url: "/health" })).json() as {
        routes: string[];
        off: { route: string; reason: string }[];
      };
      expect(health.routes).toContain("verify");
      expect(health.off.map((off) => off.route)).toEqual(["POST /prepare", "POST /generate", "POST /edit"]);
    } finally {
      await app.close();
    }
  }, 60_000);
});

describe("V94: a certificate and a key that are not a pair", () => {
  afterEach(() => {
    vi.doUnmock("../src/c2pa.js");
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("stops the signer at load, and prepare never answers embedded with it", async () => {
    const now = Date.now();
    const identity = signingIdentity(new Date(now - DAY_MS), new Date(now + DAY_MS));
    const mismatched = { certPath: identity.certPath, keyPath: identity.otherKeyPath };

    expect(() => loadSigner(mismatched)).toThrow(SignerUnavailable);
    expect(() => loadSigner(mismatched)).toThrow(/not the key/);

    const modules = await modulesSigningWith(mismatched);
    await expect(modules.c2pa.ensureSigner()).rejects.toBeInstanceOf(modules.c2pa.SignerUnavailable);
    await expect(modules.prepare.prepareOrFallback(await makeImage(941), SETTINGS)).rejects.toBeInstanceOf(
      modules.c2pa.SignerUnavailable,
    );
  }, 60_000);

  it("answers SignerUnavailable for a freshly signed file whose signature does not validate, never embedded", async () => {
    const now = Date.now();
    const identity = signingIdentity(new Date(now - DAY_MS), new Date(now + DAY_MS));
    const signer = LocalSigner.newSigner(readFileSync(identity.certPath), readFileSync(identity.otherKeyPath), "es256");

    vi.resetModules();
    vi.doMock("../src/c2pa.js", async (importOriginal) => {
      const real = await importOriginal<typeof import("../src/c2pa.js")>();
      return { ...real, embedManifest: async (bytes: Buffer, opts: EmbedOptions) => signedDirectly(bytes, opts, signer) };
    });
    const { SignerUnavailable: Unavailable } = await import("../src/c2pa.js");
    const { prepareOrFallback: prepare, prepareSealed } = await import("../src/prepare.js");

    const picture = await makeImage(942);
    await expect(prepare(picture, SETTINGS)).rejects.toBeInstanceOf(Unavailable);
    await expect(prepareSealed(picture, SETTINGS)).rejects.toBeInstanceOf(Unavailable);
  }, 60_000);
});
