// Covers POST /prepare with Pinata answered by a stub at the fetch layer and the registry read
// stubbed: a real JPEG comes back as the passport fields the browser signs, the sha256 in the
// answer is the sha256 of the bytes that were actually pinned, every accepted upload format
// leaves with a readable manifest, a picture the registry already holds is refused before
// anything is pinned, a host that cannot sign does not mount at all, the signer's own words never
// reach the answer, a training statement reaches the manifest, the pinned metadata and the answer
// while a malformed one is refused, a missing token, a bad title and a text file are each
// refused, a real picture whose thumbnail cannot fit the Chainlink budget is told so with 422
// rather than 415, while a file whose pixels do not decode keeps 415.
// From review pass 4: the review's SVG is refused in milliseconds before anything renders it
// (V17), and an upload's manifest says Moolam opened a file, never that a camera made it (V22).
// From review pass 5: a picture whose own thumbnail already reads as another picture is refused
// with 422 fingerprint-unstable (intake 1), a signed file that grew past the upload cap is refused
// with 413 before any pin (intake 2), and an upright baseline JPEG loses its EXIF, XMP and IPTC
// with no pixel changed (intake 6).
// A photo with its camera's own C2PA record answers cameraRecord "kept" or "dropped", and a plain
// upload answers no cameraRecord at all (Ram, 2026-09-26).
// Does NOT cover a real pin to Pinata, a real read
// of the registry on Monad, the remote JWKS fetch, or the per-user rate limit reaching 20 in an
// hour.

import { Reader } from "@contentauth/c2pa-node";
import { SignJWT, generateKeyPair } from "jose";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { SignerRefusedFile, SignerUnavailable, readManifest } from "../src/c2pa.js";
import { TRAINING_ASSERTION_LABEL } from "../src/consent.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MAX_UPLOAD_BYTES, PACKAGE_ROOT } from "../src/env.js";
import { PHASH_MATCH_THRESHOLD, fingerprint } from "../src/fingerprint.js";
import { fileSlug } from "../src/metadata.js";
import {
  FINGERPRINT_UNSTABLE_REASON,
  SIGNED_FILE_TOO_LARGE_REASON,
  THUMBNAIL_MAX_BYTES,
  THUMBNAIL_TOO_LARGE_REASON,
} from "../src/prepare.js";
import { contentIdOf } from "../src/ipfs/pinata.js";
import { buildServer } from "../src/server.js";
import type { PassportSource } from "../src/source/PassportSource.js";
import { FILTER_BOMB_SVG, makeImage, makeProgressiveImage, makeRotatedImage } from "./helpers.js";
import { CAMERA_SECRETS, cameraPhoto } from "./cameraPhoto.js";
import { grownWithTables } from "./jpegParts.js";

// env.ts validates once at import, so the token and the app id have to be set before any module
// in this file loads. vi.hoisted runs before the imports above. The token is a fake: every call
// to Pinata is answered by the stub below.
const APP_ID = vi.hoisted(() => {
  const id = "moolamtestapp0000001";
  process.env.PRIVY_APP_ID = id;
  process.env.PINATA_JWT = "test-token-not-a-real-pinata-jwt";
  process.env.PINATA_GATEWAY_URL = "https://moolam-test.mypinata.cloud/ipfs/";
  return id;
});

const stubs = vi.hoisted(() => ({
  ensureSigner: vi.fn(),
  embedManifest: vi.fn(),
  passportExists: vi.fn(),
}));

vi.mock("../src/c2pa.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/c2pa.js")>();
  // The signer is real for every test but the two that need it to fail, which say so themselves.
  stubs.embedManifest.mockImplementation(real.embedManifest);
  return { ...real, ensureSigner: stubs.ensureSigner, embedManifest: stubs.embedManifest };
});

vi.mock("../src/edit/registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/edit/registry.js")>()),
  passportExists: stubs.passportExists,
}));

let IMAGE: Buffer;

const UPLOAD_URL = "https://uploads.pinata.cloud/v3/files";
const emptySource: PassportSource = { load: async () => [] };

/** Every file the stub was asked to pin, in order, by the name the route gave it. */
const pinned = new Map<string, Buffer>();
let signing: CryptoKey;
let verifying: CryptoKey;
let app: FastifyInstance;

async function token(subject = "did:privy:studio-user"): Promise<string> {
  return await new SignJWT({})
    .setProtectedHeader({ alg: "ES256" })
    .setIssuer("privy.io")
    .setAudience(APP_ID)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(signing);
}

function body(parts: { file?: { name: string; type: string; bytes: Buffer }; fields?: Record<string, string> }): {
  payload: Buffer;
  headers: Record<string, string>;
} {
  const boundary = "----moolamprepare";
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(parts.fields ?? {})) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  if (parts.file !== undefined) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${parts.file.name}"\r\n` +
          `Content-Type: ${parts.file.type}\r\n\r\n`,
      ),
      parts.file.bytes,
      Buffer.from("\r\n"),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

/**
 * The review's picture for intake 1: a sky that only changes from top to bottom over a dark
 * horizon band, with plus or minus 4 of grain. The pHash never reads row 0 or column 0 of its
 * DCT block, so almost nothing in this picture decides its bits except the grain.
 */
async function skyOverHorizon(seed: number): Promise<Buffer> {
  const width = 1200;
  const height = 900;
  const horizon = Math.round(height * 0.7);
  const raw = Buffer.alloc(width * height * 3);
  let state = seed;
  const clamp = (value: number): number => Math.max(0, Math.min(255, Math.round(value)));
  for (let y = 0; y < height; y += 1) {
    const t = y / horizon;
    for (let x = 0; x < width; x += 1) {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      const grain = ((state >> 16) % 9) - 4;
      const i = (y * width + x) * 3;
      const [r, g, b] = y < horizon ? [90 + 120 * t, 150 + 80 * t, 230 + 20 * t] : [30, 34, 28];
      raw[i] = clamp(r + grain);
      raw[i + 1] = clamp(g + grain);
      raw[i + 2] = clamp(b + grain);
    }
  }
  return await sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
}

/** One JPEG marker segment: FF, the marker, a two byte length that counts itself, the payload. */
function segment(marker: number, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);
}

/** The same JPEG with extra segments right after its start marker. */
function withSegments(jpeg: Buffer, segments: Buffer[]): Buffer {
  return Buffer.concat([jpeg.subarray(0, 2), ...segments, jpeg.subarray(2)]);
}

/** Every marker a JPEG carries before its first scan, in order. */
function markersBeforeScan(jpeg: Buffer): number[] {
  const markers: number[] = [];
  let offset = 2;
  while (offset + 4 <= jpeg.length && jpeg[offset] === 0xff) {
    const marker = jpeg[offset + 1] as number;
    markers.push(marker);
    if (marker === 0xda) {
      break;
    }
    offset += 2 + jpeg.readUInt16BE(offset + 2);
  }
  return markers;
}

describe("POST /prepare", () => {
  beforeAll(async () => {
    IMAGE = await makeImage(7);
    stubs.ensureSigner.mockResolvedValue(undefined);
    stubs.passportExists.mockResolvedValue(false);
    const pair = await generateKeyPair("ES256", { extractable: true });
    signing = pair.privateKey;
    verifying = pair.publicKey;

    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== UPLOAD_URL) {
        return await realFetch(input, init);
      }
      const form = init?.body as FormData;
      const file = form.get("file") as File;
      const bytes = Buffer.from(await file.arrayBuffer());
      pinned.set(String(form.get("name")), bytes);
      return new Response(JSON.stringify({ data: { cid: contentIdOf(bytes), size: bytes.length, network: "public" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    app = await buildServer({ source: emptySource, logger: false, prepare: { keys: verifying } });
    await app.ready();
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await app.close();
  });

  it("pins the image, the thumbnail, the manifest and the metadata, and answers with the passport fields", async () => {
    const image = IMAGE;
    const { payload, headers } = body({
      file: { name: "storm.jpg", type: "image/jpeg", bytes: image },
      fields: { title: "Lighthouse in a storm", kind: "human" },
    });

    const response = await app.inject({
      method: "POST",
      url: "/prepare",
      payload,
      headers: { ...headers, authorization: `Bearer ${await token()}` },
      remoteAddress: "203.0.113.20",
    });

    expect(response.statusCode).toBe(200);
    const answer = response.json();

    const pinnedImage = pinned.get("lighthouse-in-a-storm-" + answer.passport.exactHash.slice(2, 10) + ".jpg");
    expect(pinnedImage).toBeDefined();
    const print = await fingerprint(pinnedImage as Buffer);

    expect(answer.passport.exactHash).toBe(print.sha256);
    expect(answer.passport.phash).toBe(print.phash.toString());
    expect(answer.passport.blockhash256).toBe(print.blockhash);
    expect(answer.passport.kind).toBe(1);
    expect(answer.passport.fingerprintVersion).toBe(1);
    expect(answer.passport.parentId).toBe(`0x${"00".repeat(32)}`);
    expect(answer.passport.generatorAgentId).toBe("0");
    expect(answer.passport.metadataURI).toMatch(/^ipfs:\/\/.+/);
    expect(answer.passport.manifestHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(answer.manifest.embedded).toBe(true);
    expect(answer.image.bytes).toBe((pinnedImage as Buffer).length);
    expect(answer.image.width).toBe(print.width);
    expect(answer.thumbnail.gatewayUrl).toMatch(/^https:\/\/moolam-test\.mypinata\.cloud\/ipfs\//);
    expect(answer.preparedBy).toBe("did:privy:studio-user");
    expect(JSON.stringify(answer)).not.toContain("test-token-not-a-real-pinata-jwt");
  }, 60_000);

  it("embeds a readable manifest whatever format the creator uploads", async () => {
    const uploads = [
      { format: "jpeg", type: "image/jpeg", bytes: await makeImage(21) },
      { format: "png", type: "image/png", bytes: await makeImage(22, "png") },
      { format: "webp", type: "image/webp", bytes: await makeImage(23, "webp") },
      { format: "progressive-jpeg", type: "image/jpeg", bytes: await makeProgressiveImage(24) },
      { format: "rotated-jpeg", type: "image/jpeg", bytes: (await makeRotatedImage(25)).tagged },
    ];

    for (const upload of uploads) {
      const title = `Format ${upload.format}`;
      const { payload, headers } = body({
        file: { name: `upload-${upload.format}`, type: upload.type, bytes: upload.bytes },
        fields: { title, kind: "human" },
      });

      const response = await app.inject({
        method: "POST",
        url: "/prepare",
        payload,
        headers: { ...headers, authorization: `Bearer ${await token("did:privy:format-user")}` },
        remoteAddress: "203.0.113.23",
      });

      expect(response.statusCode, upload.format).toBe(200);
      const answer = response.json();
      expect(answer.manifest, upload.format).toEqual({ embedded: true });
      expect(answer.passport.manifestHash, upload.format).toMatch(/^0x[0-9a-f]{64}$/);
      expect(answer.passport.manifestHash, upload.format).not.toBe(`0x${"00".repeat(32)}`);

      const pinnedImage = pinned.get(`${fileSlug(title, answer.passport.exactHash)}.jpg`);
      expect(pinnedImage, upload.format).toBeDefined();
      const print = await fingerprint(pinnedImage as Buffer);
      expect(print.format, upload.format).toBe("jpeg");
      expect(answer.passport.exactHash, upload.format).toBe(print.sha256);

      const manifest = await readManifest(pinnedImage as Buffer);
      expect(manifest.present, upload.format).toBe(true);
      expect(manifest.manifestHash, upload.format).toBe(answer.passport.manifestHash);
      expect(manifest.softBinding?.phash, upload.format).toBe(print.phash);
      expect(manifest.softBinding?.blockhash, upload.format).toBe(print.blockhash);
    }
  }, 180_000);

  it("writes the creator's training statement into the manifest, the metadata and the answer", async () => {
    const title = "Nets at first light";
    const training = {
      aiTraining: "allowed",
      aiGenerativeTraining: "notAllowed",
      dataMining: "constrained",
      constraintInfo: "ask hello@moolam.app",
    };
    const { payload, headers } = body({
      file: { name: "nets.jpg", type: "image/jpeg", bytes: await makeImage(33) },
      fields: { title, kind: "human", training: JSON.stringify(training) },
    });

    const response = await app.inject({
      method: "POST",
      url: "/prepare",
      payload,
      headers: { ...headers, authorization: `Bearer ${await token("did:privy:consent-user")}` },
      remoteAddress: "203.0.113.26",
    });

    expect(response.statusCode).toBe(200);
    const answer = response.json();
    expect(answer.training).toEqual({ ...training, standard: "cawg.training-mining/1.1" });

    const slug = fileSlug(title, answer.passport.exactHash);
    const metadata = JSON.parse((pinned.get(`${slug}.json`) as Buffer).toString("utf8"));
    expect(metadata.training).toEqual({ ...training, standard: "cawg.training-mining/1.1" });

    const reader = await Reader.fromAsset({ buffer: pinned.get(`${slug}.jpg`) as Buffer, mimeType: "image/jpeg" });
    const assertion = (reader?.getActive()?.assertions ?? []).find((one) =>
      one.label?.startsWith(TRAINING_ASSERTION_LABEL),
    );
    expect(assertion?.data).toEqual({
      entries: {
        "cawg.ai_training": { use: "allowed" },
        "cawg.ai_generative_training": { use: "notAllowed" },
        "cawg.data_mining": { use: "constrained", constraint_info: "ask hello@moolam.app" },
      },
    });
  }, 60_000);

  it("pins nothing and names the field when the training statement is not one the standard allows", async () => {
    const pinsBefore = pinned.size;
    const bearer = `Bearer ${await token("did:privy:consent-user")}`;
    const refusals: { training: string; names: string }[] = [
      { training: JSON.stringify({ aiTraining: "allowed", constraintInfo: "ask me" }), names: "constraintInfo" },
      { training: JSON.stringify({ aiTraining: "constrained" }), names: "constraintInfo" },
      { training: JSON.stringify({ aiTraining: "constrained", constraintInfo: "x".repeat(257) }), names: "constraintInfo" },
      { training: JSON.stringify({ aiTraining: "constrained", constraintInfo: "ask\nme" }), names: "constraintInfo" },
      { training: JSON.stringify({ aiTraining: "constrained", constraintInfo: "ask me ©" }), names: "constraintInfo" },
      { training: JSON.stringify({ aiTraining: "sometimes" }), names: "aiTraining" },
      { training: "not json at all", names: "training" },
    ];

    for (const refusal of refusals) {
      const { payload, headers } = body({
        file: { name: "nets.jpg", type: "image/jpeg", bytes: IMAGE },
        fields: { title: "Refused statement", kind: "human", training: refusal.training },
      });

      const response = await app.inject({
        method: "POST",
        url: "/prepare",
        payload,
        headers: { ...headers, authorization: bearer },
        remoteAddress: "203.0.113.26",
      });

      expect(response.statusCode, refusal.training).toBe(400);
      expect(response.json().error, refusal.training).toContain(refusal.names);
    }
    expect(pinned.size).toBe(pinsBefore);
  }, 60_000);

  it("refuses a request with no token before it reads the upload", async () => {
    const pinsBefore = pinned.size;
    const { payload, headers } = body({
      file: { name: "storm.jpg", type: "image/jpeg", bytes: IMAGE },
      fields: { title: "No token", kind: "human" },
    });

    const response = await app.inject({ method: "POST", url: "/prepare", payload, headers });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "unauthorized" });
    expect(pinned.size).toBe(pinsBefore);
  });

  it("refuses a file that is not an image with 415", async () => {
    const { payload, headers } = body({
      file: { name: "notes.txt", type: "text/plain", bytes: Buffer.from("not an image") },
      fields: { title: "Notes", kind: "human" },
    });

    const response = await app.inject({
      method: "POST",
      url: "/prepare",
      payload,
      headers: { ...headers, authorization: `Bearer ${await token("did:privy:text-user")}` },
      remoteAddress: "203.0.113.21",
    });

    expect(response.statusCode).toBe(415);
    expect(response.json()).toEqual({ error: "not-an-image" });
  });

  it("V17: refuses the review's SVG with 415 in milliseconds, public or sealed, and pins nothing", async () => {
    const pinsBefore = pinned.size;
    for (const sealed of ["false", "true"]) {
      const { payload, headers } = body({
        file: { name: "bomb.svg", type: "image/svg+xml", bytes: FILTER_BOMB_SVG },
        fields: { title: "Turbulence", kind: "human", sealed },
      });
      const started = performance.now();

      const response = await app.inject({
        method: "POST",
        url: "/prepare",
        payload,
        headers: { ...headers, authorization: `Bearer ${await token("did:privy:svg-user")}` },
        remoteAddress: "203.0.113.28",
      });

      expect(performance.now() - started, sealed).toBeLessThan(1_000);
      expect(response.statusCode, sealed).toBe(415);
      expect(response.json(), sealed).toEqual({ error: "not-an-image" });
    }
    expect(pinned.size).toBe(pinsBefore);
  }, 60_000);

  it("V22: signs an upload as a file Moolam opened, with no source type Moolam could not see", async () => {
    const title = "Harbour at dusk";
    const { payload, headers } = body({
      file: { name: "harbour.jpg", type: "image/jpeg", bytes: await makeImage(34) },
      fields: { title, kind: "human" },
    });

    const response = await app.inject({
      method: "POST",
      url: "/prepare",
      payload,
      headers: { ...headers, authorization: `Bearer ${await token("did:privy:source-user")}` },
      remoteAddress: "203.0.113.29",
    });

    expect(response.statusCode).toBe(200);
    const signed = pinned.get(`${fileSlug(title, response.json().passport.exactHash)}.jpg`) as Buffer;
    const reader = await Reader.fromAsset({ buffer: signed, mimeType: "image/jpeg" });
    const actions = (reader?.getActive()?.assertions ?? [])
      .filter((one) => one.label?.startsWith("c2pa.actions"))
      .flatMap((one) => (one.data as { actions: Record<string, unknown>[] }).actions);

    expect(actions.map((one) => one.action)).toEqual(["c2pa.opened"]);
    expect(JSON.stringify(actions)).not.toContain("digitalSourceType");
    expect(JSON.stringify(actions)).not.toContain("digitalCapture");
    expect((await readManifest(signed)).validation).toBe("valid");
  }, 60_000);

  it("camera record: says kept, dropped, or nothing, and never pins the camera's location or serial", async () => {
    const send = async (bytes: Buffer, title: string) => {
      const { payload, headers } = body({ file: { name: "camera.jpg", type: "image/jpeg", bytes }, fields: { title, kind: "human" } });
      const response = await app.inject({
        method: "POST",
        url: "/prepare",
        payload,
        headers: { ...headers, authorization: `Bearer ${await token("did:privy:camera-user")}` },
        remoteAddress: "203.0.113.34",
      });
      expect(response.statusCode, title).toBe(200);
      const answer = response.json();
      return { manifest: answer.manifest, pinned: pinned.get(`${fileSlug(title, answer.passport.exactHash)}.jpg`) as Buffer };
    };
    const camera = await cameraPhoto(93);

    const kept = await send(camera, "Kept camera record");
    // The signer takes the file, then refuses it once the camera's record and its redactions are in.
    stubs.embedManifest.mockRejectedValueOnce(new SignerRefusedFile("assertion could not be redacted"));
    const dropped = await send(camera, "Dropped camera record");
    const plain = await send(await makeImage(93), "No camera record");

    expect(kept.manifest).toEqual({ embedded: true, cameraRecord: "kept" });
    expect(dropped.manifest).toEqual({ embedded: true, cameraRecord: "dropped" });
    expect(plain.manifest).toEqual({ embedded: true });
    for (const file of [kept.pinned, dropped.pinned]) {
      for (const secret of Object.values(CAMERA_SECRETS)) {
        expect(file.includes(Buffer.from(secret)), secret).toBe(false);
      }
    }
    expect((await readManifest(dropped.pinned)).ingredients).toBe(1);
  }, 60_000);

  it("refuses a picture whose thumbnail cannot fit the Chainlink budget with 422, and pins nothing", async () => {
    // Pure noise at full quality: the one kind of picture a 512 pixel JPEG cannot squeeze under 60 KB.
    const side = 512;
    const raw = Buffer.alloc(side * side * 3);
    let state = 12345;
    for (let i = 0; i < raw.length; i += 1) {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      raw[i] = (state >> 16) & 0xff;
    }
    const noise = await sharp(raw, { raw: { width: side, height: side, channels: 3 } }).jpeg({ quality: 100 }).toBuffer();
    const pinsBefore = pinned.size;
    const { payload, headers } = body({
      file: { name: "noise.jpg", type: "image/jpeg", bytes: noise },
      fields: { title: "Static", kind: "human" },
    });

    const response = await app.inject({
      method: "POST",
      url: "/prepare",
      payload,
      headers: { ...headers, authorization: `Bearer ${await token("did:privy:noise-user")}` },
      remoteAddress: "203.0.113.26",
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({
      error: "thumbnail-too-large",
      limit: THUMBNAIL_MAX_BYTES,
      reason: THUMBNAIL_TOO_LARGE_REASON,
    });
    expect(pinned.size).toBe(pinsBefore);
  }, 60_000);

  it("intake 1: refuses a sky over a horizon with 422 fingerprint-unstable, public or sealed, and pins nothing", async () => {
    const sky = await skyOverHorizon(1);
    const pinsBefore = pinned.size;
    for (const sealed of ["false", "true"]) {
      const { payload, headers } = body({
        file: { name: "sky.jpg", type: "image/jpeg", bytes: sky },
        fields: { title: "Clear sky", kind: "human", sealed },
      });

      const response = await app.inject({
        method: "POST",
        url: "/prepare",
        payload,
        headers: { ...headers, authorization: `Bearer ${await token("did:privy:sky-user")}` },
        remoteAddress: "203.0.113.30",
      });

      expect(response.statusCode, sealed).toBe(422);
      const answer = response.json();
      expect(answer.error, sealed).toBe("fingerprint-unstable");
      expect(answer.limit, sealed).toBe(PHASH_MATCH_THRESHOLD);
      expect(answer.distance, sealed).toBeGreaterThan(PHASH_MATCH_THRESHOLD);
      expect(answer.reason, sealed).toBe(FINGERPRINT_UNSTABLE_REASON);
    }
    expect(pinned.size).toBe(pinsBefore);
  }, 60_000);

  it("intake 1: takes a picture Moolam really pinned, whose thumbnail reads as the same picture", async () => {
    const hero = readFileSync(path.join(PACKAGE_ROOT, "test", "fixtures", "pinned-hero.jpg"));
    const { payload, headers } = body({
      file: { name: "hero.jpg", type: "image/jpeg", bytes: hero },
      fields: { title: "The hero picture", kind: "human" },
    });

    const response = await app.inject({
      method: "POST",
      url: "/prepare",
      payload,
      headers: { ...headers, authorization: `Bearer ${await token("did:privy:hero-user")}` },
      remoteAddress: "203.0.113.31",
    });

    expect(response.statusCode).toBe(200);
  }, 60_000);

  it("intake 2: refuses with 413 when signing grows an upload just under the cap past it, public or sealed", async () => {
    // Repeated quantisation tables survive every step before signing, where comments no longer do
    // (pass 6, intake 1), so the file stays just under the cap until the manifest store goes in.
    const nearCap = grownWithTables(await makeImage(41), MAX_UPLOAD_BYTES - 20_000);
    expect(nearCap.length).toBeLessThan(MAX_UPLOAD_BYTES);
    expect(nearCap.length).toBeGreaterThan(MAX_UPLOAD_BYTES - 30_000);

    const pinsBefore = pinned.size;
    for (const sealed of ["false", "true"]) {
      const { payload, headers } = body({
        file: { name: "big.jpg", type: "image/jpeg", bytes: nearCap },
        fields: { title: "Nearly too big", kind: "human", sealed },
      });

      const response = await app.inject({
        method: "POST",
        url: "/prepare",
        payload,
        headers: { ...headers, authorization: `Bearer ${await token("did:privy:big-user")}` },
        remoteAddress: "203.0.113.32",
      });

      expect(response.statusCode, sealed).toBe(413);
      expect(response.json(), sealed).toEqual({
        error: "signed-file-too-large",
        limit: MAX_UPLOAD_BYTES,
        reason: SIGNED_FILE_TOO_LARGE_REASON,
      });
    }
    expect(pinned.size).toBe(pinsBefore);
  }, 120_000);

  it("intake 6: an upright baseline JPEG loses its EXIF, XMP and IPTC before signing, with no pixel changed", async () => {
    const tagged = await sharp(await makeImage(42))
      .withExif({
        IFD0: { Make: "Moolam Test Camera", Model: "Serial 0042" },
        IFD3: { GPSLatitudeRef: "N", GPSLatitude: "13/1 4/1 0/1", GPSLongitudeRef: "E", GPSLongitude: "80/1 16/1 0/1" },
      })
      .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/></x:xmpmeta>')
      .jpeg({ quality: 92 })
      .toBuffer();
    const upload = withSegments(tagged, [segment(0xed, Buffer.from("Photoshop 3.0\u00008BIM\u0004\u0004Chennai", "latin1"))]);
    expect(markersBeforeScan(upload)).toContain(0xe1);
    expect(markersBeforeScan(upload)).toContain(0xed);
    expect((await sharp(upload).metadata()).isProgressive).toBe(false);

    const title = "Tagged at the harbour";
    const { payload, headers } = body({
      file: { name: "tagged.jpg", type: "image/jpeg", bytes: upload },
      fields: { title, kind: "human" },
    });
    const response = await app.inject({
      method: "POST",
      url: "/prepare",
      payload,
      headers: { ...headers, authorization: `Bearer ${await token("did:privy:exif-user")}` },
      remoteAddress: "203.0.113.33",
    });

    expect(response.statusCode).toBe(200);
    const signed = pinned.get(`${fileSlug(title, response.json().passport.exactHash)}.jpg`) as Buffer;
    expect(markersBeforeScan(signed)).not.toContain(0xe1);
    expect(markersBeforeScan(signed)).not.toContain(0xed);
    expect(markersBeforeScan(signed)).toContain(0xeb);
    const meta = await sharp(signed).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.iptc).toBeUndefined();
    expect(signed.includes(Buffer.from("Serial 0042"))).toBe(false);
    expect((await readManifest(signed)).validation).toBe("valid");

    const before = await sharp(upload).raw().toBuffer();
    const after = await sharp(signed).raw().toBuffer();
    expect(after.equals(before)).toBe(true);
  }, 60_000);

  it("keeps 415 for a picture whose header reads and whose pixels do not decode", async () => {
    const truncated = IMAGE.subarray(0, Math.floor(IMAGE.length / 2));
    const pinsBefore = pinned.size;
    const { payload, headers } = body({
      file: { name: "cut.jpg", type: "image/jpeg", bytes: truncated },
      fields: { title: "Cut short", kind: "human" },
    });

    const response = await app.inject({
      method: "POST",
      url: "/prepare",
      payload,
      headers: { ...headers, authorization: `Bearer ${await token("did:privy:truncated-user")}` },
      remoteAddress: "203.0.113.27",
    });

    expect(response.statusCode).toBe(415);
    expect(response.json().error).toBe("not-an-image");
    expect(pinned.size).toBe(pinsBefore);
  }, 60_000);

  it("refuses a picture the registry already holds with 409, before anything is pinned", async () => {
    stubs.passportExists.mockResolvedValueOnce(true);
    const pinsBefore = pinned.size;
    const { payload, headers } = body({
      file: { name: "again.jpg", type: "image/jpeg", bytes: await makeImage(31) },
      fields: { title: "Registered already", kind: "human" },
    });

    const response = await app.inject({
      method: "POST",
      url: "/prepare",
      payload,
      headers: { ...headers, authorization: `Bearer ${await token("did:privy:duplicate-user")}` },
      remoteAddress: "203.0.113.24",
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("already-registered");
    expect(response.json().passportId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(pinned.size).toBe(pinsBefore);
  }, 60_000);

  it("keeps the signer's own words, and any path in them, out of the answer", async () => {
    const certPath = "/srv/moolam/secrets/chain.cert.pem";
    stubs.embedManifest.mockRejectedValueOnce(
      new SignerRefusedFile(`the signer at ${certPath} would not take this container`),
    );

    const { payload, headers } = body({
      file: { name: "unsignable.jpg", type: "image/jpeg", bytes: await makeImage(32) },
      fields: { title: "No manifest", kind: "human" },
    });

    const response = await app.inject({
      method: "POST",
      url: "/prepare",
      payload,
      headers: { ...headers, authorization: `Bearer ${await token("did:privy:unsigned-user")}` },
      remoteAddress: "203.0.113.25",
    });

    expect(response.statusCode).toBe(200);
    const answer = response.json();
    expect(answer.manifest.embedded).toBe(false);
    expect(answer.manifest.reason).toBe("the manifest could not be embedded in this file");
    expect(answer.passport.manifestHash).toBe(`0x${"00".repeat(32)}`);
    expect(response.body).not.toContain(certPath);
    expect(response.body).not.toContain(".pem");
  }, 60_000);

  it("does not mount at all on a host that cannot sign, rather than answering 200 unsigned", async () => {
    const message = "no signing certificate or key found at /srv/moolam/chain.cert.pem and /srv/moolam/signer.key.pem";
    stubs.ensureSigner.mockRejectedValueOnce(new SignerUnavailable(message));

    await expect(
      buildServer({ source: emptySource, logger: false, prepare: { keys: verifying } }),
    ).rejects.toThrow(SignerUnavailable);
  });

  it("refuses an empty title, an over-long title and a kind the studio does not take", async () => {
    const image = IMAGE;
    const bearer = `Bearer ${await token("did:privy:title-user")}`;

    for (const fields of [
      { title: "   ", kind: "human" },
      { title: "x".repeat(121), kind: "human" },
      { title: "Fine title", kind: "generated" },
    ]) {
      const { payload, headers } = body({ file: { name: "storm.jpg", type: "image/jpeg", bytes: image }, fields });
      const response = await app.inject({
        method: "POST",
        url: "/prepare",
        payload,
        headers: { ...headers, authorization: bearer },
        remoteAddress: "203.0.113.22",
      });

      expect(response.statusCode, JSON.stringify(fields)).toBe(400);
    }
  }, 30_000);
});
