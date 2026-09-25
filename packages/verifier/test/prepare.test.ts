// Covers POST /prepare with Pinata answered by a stub at the fetch layer and the registry read
// stubbed: a real JPEG comes back as the passport fields the browser signs, the sha256 in the
// answer is the sha256 of the bytes that were actually pinned, every accepted upload format
// leaves with a readable manifest, a picture the registry already holds is refused before
// anything is pinned, a host that cannot sign does not mount at all, the signer's own words never
// reach the answer, a training statement reaches the manifest, the pinned metadata and the answer
// while a malformed one is refused, a missing token, a bad title and a text file are each
// refused, a real picture whose thumbnail cannot fit the Chainlink budget is told so with 422
// rather than 415, while a file whose pixels do not decode keeps 415.
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
import { PACKAGE_ROOT } from "../src/env.js";
import { fingerprint } from "../src/fingerprint.js";
import { fileSlug } from "../src/metadata.js";
import { THUMBNAIL_MAX_BYTES, THUMBNAIL_TOO_LARGE_REASON } from "../src/prepare.js";
import { buildServer } from "../src/server.js";
import type { PassportSource } from "../src/source/PassportSource.js";
import { makeImage, makeProgressiveImage, makeRotatedImage } from "./helpers.js";

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
      const cid = `bafytest${pinned.size}`;
      return new Response(JSON.stringify({ data: { cid, size: bytes.length } }), {
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
