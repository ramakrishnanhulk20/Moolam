// Covers the sealed path on POST /prepare and POST /generate, with Pinata answered by a recording
// stub at the fetch layer and the image model, the caller's wallets, the Privy signer and the
// registry read all stubbed. It is written against the sealed promises in
// docs/security/threat-model.md, and each test names the invariant it holds up:
// (1) nothing of the picture is stored, so zero file pins and no new file anywhere this process
// can write, (2) nothing of the picture is published, so the one pinned document is validated by
// a strict schema that has no room for an image, a thumbnail, a manifest or an unasked-for
// prompt, and (4) bytes are never cached or logged, so the answer is no-store and a captured
// logger carries neither the base64 nor the raw bytes. It also holds the signed file the creator
// gets to the passport id that commits to it, and checks that the public path did not move.
// Does NOT cover invariant 3 (the studio refuses the passkey prompt until the browser holds the
// bytes), 5 and 6 (unsealing), 7 (how sealed reads on every screen) or 8 (what the creator sees
// before signing): those are the browser's half and other files. It does not cover a real pin, a
// real image model call, or the per-hour prepare limit reaching 20.

import fs, { mkdirSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { SignJWT, generateKeyPair } from "jose";
import { getAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { SignerRefusedFile, readManifest } from "../src/c2pa.js";
import { PACKAGE_ROOT } from "../src/env.js";
import { fileSlug } from "../src/metadata.js";
import { NOT_EMBEDDED_REASON } from "../src/prepare.js";
import {
  SEALED_METADATA_REFUSED,
  checkedSealedMetadata,
  sealedMetadata,
  sealedMetadataSchema,
  type SealedMetadata,
} from "../src/sealed.js";
import { contentIdOf } from "../src/ipfs/pinata.js";
import { buildServer } from "../src/server.js";
import type { PassportSource } from "../src/source/PassportSource.js";
import { makeImage, makeOversizeImage } from "./helpers.js";

// env.ts validates once at import, so everything the two routes read has to be set before any
// module in this file loads. vi.hoisted runs before the imports above. The Pinata token is a
// fake: every call to Pinata is answered by the recording stub below.
const APP_ID = vi.hoisted(() => {
  const id = "moolamtestapp0000003";
  process.env.PRIVY_APP_ID = id;
  process.env.PINATA_JWT = "test-token-not-a-real-pinata-jwt";
  process.env.PINATA_GATEWAY_URL = "https://moolam-test.mypinata.cloud/ipfs/";
  process.env.GENERATE_PER_DAY = "2";
  process.env.GENERATOR_AGENT_ID = "10249";
  return id;
});

const stubs = vi.hoisted(() => ({
  passportExists: vi.fn(),
  createImage: vi.fn(),
  sign: vi.fn(),
  wallet: vi.fn(),
  embeddedWallets: vi.fn(),
  embedManifest: vi.fn(),
  sealedMetadata: vi.fn(),
  signedFile: vi.fn(),
  prepareSealed: vi.fn(),
}));

vi.mock("../src/edit/registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/edit/registry.js")>()),
  passportExists: stubs.passportExists,
}));

// The signer is the real one for every test but the one that needs it to refuse a file, which
// says so itself. Same for the sealed builder and the test that needs it to hand back a record
// carrying a key the sealed shape has no room for.
vi.mock("../src/c2pa.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/c2pa.js")>();
  stubs.embedManifest.mockImplementation(real.embedManifest);
  return { ...real, embedManifest: stubs.embedManifest };
});

vi.mock("../src/sealed.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/sealed.js")>();
  stubs.sealedMetadata.mockImplementation(real.sealedMetadata);
  stubs.signedFile.mockImplementation(real.signedFile);
  return { ...real, sealedMetadata: stubs.sealedMetadata, signedFile: stubs.signedFile };
});

// The real pipeline for every test but the one that needs a sealed drawing to carry a key the
// sealed path has no use for, which is how the answer proves it is chosen by the creator's flag.
vi.mock("../src/prepare.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/prepare.js")>();
  stubs.prepareSealed.mockImplementation(real.prepareSealed);
  return { ...real, prepareSealed: stubs.prepareSealed };
});

vi.mock("../src/auth/wallet.js", () => ({ embeddedWallets: stubs.embeddedWallets }));

vi.mock("../src/generate/imageModel.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/generate/imageModel.js")>()),
  createImage: stubs.createImage,
}));

vi.mock("../src/generate/generatorSigner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/generate/generatorSigner.js")>()),
  generatorWallet: stubs.wallet,
  signPassportAsGenerator: stubs.sign,
}));

const UPLOAD_URL = "https://uploads.pinata.cloud/v3/files";
const PROMPT = "A lighthouse in a monsoon storm, painted in thick oils";
const MODEL = "gpt-image-1-mini";
const CREATOR = getAddress("0x85a88ca81ff5f681d96ab86fa60ccb8452a139a6" as Hex);
const emptySource: PassportSource = { load: async () => [] };

/** Every pin the stub was asked for, in order, with the content type the route chose for it. */
interface Pin {
  name: string;
  type: string;
  bytes: Buffer;
}

const pins: Pin[] = [];
let IMAGE: Buffer;
let signing: CryptoKey;
let verifying: CryptoKey;
let agent: PrivateKeyAccount;
let app: FastifyInstance;

async function token(subject: string): Promise<string> {
  return await new SignJWT({})
    .setProtectedHeader({ alg: "ES256" })
    .setIssuer("privy.io")
    .setAudience(APP_ID)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(signing);
}

function multipart(fields: Record<string, string>, file: Buffer): {
  payload: Buffer;
  headers: Record<string, string>;
} {
  const boundary = "----moolamsealed";
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="upload.jpg"\r\n` +
        "Content-Type: image/jpeg\r\n\r\n",
    ),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return { payload: Buffer.concat(chunks), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

async function prepare(
  instance: FastifyInstance,
  subject: string,
  fields: Record<string, string>,
  file?: Buffer,
): Promise<LightMyRequestResponse> {
  const { payload, headers } = multipart(fields, file ?? IMAGE);
  return await instance.inject({
    method: "POST",
    url: "/prepare",
    payload,
    headers: { ...headers, authorization: `Bearer ${await token(subject)}` },
    remoteAddress: "198.51.100.10",
  });
}

async function generate(subject: string, body: Record<string, unknown>): Promise<LightMyRequestResponse> {
  return await app.inject({
    method: "POST",
    url: "/generate",
    payload: body,
    headers: { authorization: `Bearer ${await token(subject)}` },
    remoteAddress: "198.51.100.11",
  });
}

function drawn(title: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    prompt: PROMPT,
    title,
    creator: CREATOR,
    deadline: Math.floor(Date.now() / 1000) + 1800,
    ...extra,
  };
}

/** The pins made since a mark, which is how a test says "this request pinned exactly these". */
function pinsSince(mark: number): Pin[] {
  return pins.slice(mark);
}

/** A sealed record that fits the shape, for the tests that then break it on purpose. */
function aSealedDocument(): SealedMetadata {
  return sealedMetadata({
    title: "A sealed picture",
    description: "A picture registered with Moolam and kept sealed.",
    passportId: `0x${"11".repeat(32)}` as Hex,
    fingerprint: {
      sha256: `0x${"11".repeat(32)}` as Hex,
      phash: 1234n,
      blockhash: `0x${"22".repeat(32)}` as Hex,
      width: 640,
      height: 480,
      format: "jpeg",
    },
  });
}

/**
 * Everything this service writes to the console while `work` runs.
 *
 * The logger reaches the terminal by two different roads: a plain node run writes through
 * process.stdout, and under this test runner pino writes to file descriptor 1 through fs.write.
 * Both are watched, and the test that uses this insists the capture is not empty, so a third road
 * would show up as a failure rather than as a test that quietly proves nothing.
 */
async function captureLog(
  work: () => Promise<LightMyRequestResponse>,
): Promise<{ response: LightMyRequestResponse; logged: string }> {
  const lines: string[] = [];
  const keep = (chunk: unknown): void => {
    if (typeof chunk === "string") {
      lines.push(chunk);
    } else if (chunk instanceof Uint8Array) {
      lines.push(Buffer.from(chunk).toString("utf8"));
    }
  };

  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    keep(chunk);
    return true;
  });
  const realWrite = fs.write;
  const realWriteSync = fs.writeSync;
  const patched = fs as unknown as Record<string, unknown>;
  patched.write = (...args: unknown[]): unknown => {
    if (args[0] === 1) {
      keep(args[1]);
    }
    return (realWrite as unknown as (...rest: unknown[]) => unknown)(...args);
  };
  patched.writeSync = (...args: unknown[]): unknown => {
    if (args[0] === 1) {
      keep(args[1]);
    }
    return (realWriteSync as unknown as (...rest: unknown[]) => unknown)(...args);
  };

  try {
    const response = await work();
    // The completed line is written after the reply and the log buffer flushes on its own clock,
    // so the capture waits a moment instead of racing it.
    await new Promise((resolve) => setTimeout(resolve, 150));
    return { response, logged: lines.join("") };
  } finally {
    patched.write = realWrite;
    patched.writeSync = realWriteSync;
    stdout.mockRestore();
  }
}

function recordingPinata(): void {
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== UPLOAD_URL) {
      return await realFetch(input, init);
    }
    const form = init?.body as FormData;
    const file = form.get("file") as File;
    const bytes = Buffer.from(await file.arrayBuffer());
    pins.push({ name: String(form.get("name")), type: file.type, bytes });
    return new Response(JSON.stringify({ data: { cid: contentIdOf(bytes), size: bytes.length, network: "public" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

describe("a sealed registration", () => {
  beforeAll(async () => {
    IMAGE = await makeImage(11);
    stubs.passportExists.mockResolvedValue(false);
    const pair = await generateKeyPair("ES256", { extractable: true });
    signing = pair.privateKey;
    verifying = pair.publicKey;
    agent = privateKeyToAccount(generatePrivateKey());
    stubs.wallet.mockImplementation(async () => ({ id: "moolam-test-generator", address: agent.address }));
    stubs.sign.mockImplementation(async () => `0x${"ab".repeat(65)}`);
    stubs.embeddedWallets.mockImplementation(async () => [CREATOR]);
    stubs.createImage.mockImplementation(async (prompt: string) => ({
      bytes: await makeImage(prompt.length % 40),
      model: MODEL,
      promptUsed: prompt,
    }));
    recordingPinata();

    app = await buildServer({
      source: emptySource,
      logger: false,
      prepare: { keys: verifying },
      generate: { keys: verifying },
    });
    await app.ready();
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    await app.close();
  });

  // Invariant 1: nothing of the picture is stored.
  it("pins one JSON document and not a single file, on /prepare and on /generate", async () => {
    const preparedMark = pins.length;
    const prepared = await prepare(app, "did:privy:sealed-prepare", {
      title: "Sealed nets",
      kind: "human",
      sealed: "true",
    });
    expect(prepared.statusCode).toBe(200);
    const fromPrepare = pinsSince(preparedMark);

    const drawnMark = pins.length;
    const generated = await generate("did:privy:sealed-generate", drawn("Sealed lighthouse", { sealed: true }));
    expect(generated.statusCode).toBe(200);
    const fromGenerate = pinsSince(drawnMark);

    for (const [route, title, made, answer] of [
      ["/prepare", "Sealed nets", fromPrepare, prepared.json()],
      ["/generate", "Sealed lighthouse", fromGenerate, generated.json()],
    ] as const) {
      expect(made.map((pin) => pin.type), route).toEqual(["application/json"]);
      expect((made[0] as Pin).name, route).toBe(`${fileSlug(title, answer.passport.exactHash)}.json`);
      expect(answer.sealed, route).toBe(true);
      expect(answer.image, route).toBeUndefined();
      expect(answer.thumbnail, route).toBeUndefined();
      expect(answer.manifest, route).toEqual({ embedded: true });
      expect(answer.metadata.uri, route).toMatch(/^ipfs:\/\/.+/);
      expect(answer.signedFile.sha256, route).toBe(answer.passport.exactHash);
    }

    expect(prepared.headers["cache-control"]).toBe("no-store");
    expect(generated.headers["cache-control"]).toBe("no-store");
  }, 120_000);

  // Invariant 1, the other half: no file on disk. The listing is the proof rather than a spy on
  // node:fs, because the C2PA signer is a Rust addon whose writes would never pass through it.
  // TMPDIR, TEMP and TMP are pointed at a private empty directory for the length of the two
  // requests, so anything the addon, sharp or this service asked the operating system for a
  // temporary file would land somewhere this test can see.
  it("leaves no new file in the temp directory, the package or the certificate directory", async () => {
    const privateTemp = path.join(os.tmpdir(), `moolam-sealed-${Date.now()}`);
    const watched = [privateTemp, PACKAGE_ROOT, path.join(PACKAGE_ROOT, "test-assets")];
    const kept = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
    mkdirSync(privateTemp, { recursive: true });

    const listing = (): string[][] => watched.map((directory) => readdirSync(directory).sort());
    let before: string[][] = [];
    let after: string[][] = [];
    try {
      process.env.TMPDIR = privateTemp;
      process.env.TEMP = privateTemp;
      process.env.TMP = privateTemp;
      expect(os.tmpdir()).toBe(privateTemp);

      before = listing();
      const prepared = await prepare(app, "did:privy:sealed-disk", {
        title: "Nothing on disk",
        kind: "human",
        sealed: "true",
      });
      const generated = await generate("did:privy:sealed-disk-draw", drawn("Nothing drawn to disk", { sealed: true }));
      after = listing();

      expect(prepared.statusCode).toBe(200);
      expect(generated.statusCode).toBe(200);
    } finally {
      process.env.TMPDIR = kept.TMPDIR;
      process.env.TEMP = kept.TEMP;
      process.env.TMP = kept.TMP;
    }

    watched.forEach((directory, index) => {
      const added = (after[index] ?? []).filter((entry) => !(before[index] ?? []).includes(entry));
      expect(added, directory).toEqual([]);
    });
  }, 120_000);

  // Invariant 2: nothing of the picture is published.
  it("pins a document with no image, thumbnail, manifest or prompt in it", async () => {
    const mark = pins.length;
    const response = await prepare(app, "did:privy:sealed-document", {
      title: "What is public",
      kind: "human",
      sealed: "true",
      training: JSON.stringify({ aiGenerativeTraining: "notAllowed" }),
    });

    expect(response.statusCode).toBe(200);
    const answer = response.json();
    const pinned = pinsSince(mark);
    expect(pinned).toHaveLength(1);
    const document = JSON.parse((pinned[0] as Pin).bytes.toString("utf8"));

    expect(Object.keys(document).sort()).toEqual([
      "commitment",
      "createdAt",
      "description",
      "fingerprint",
      "name",
      "sealed",
      "training",
    ]);
    expect(document.sealed).toBe(true);
    expect(document.commitment).toEqual({ algorithm: "sha-256", value: answer.passport.exactHash });
    expect(document.fingerprint.blockhash).toBe(answer.passport.blockhash256);
    expect(document.fingerprint.version).toBe(1);
    expect(document.training).toEqual({ aiGenerativeTraining: "notAllowed", standard: "cawg.training-mining/1.1" });
    expect(document.name).toBe("What is public");
    expect(document.description).toContain("sealed");

    // The two fingerprints and the title are the whole of what a sealed passport gives away, so
    // nothing in the document may carry the picture or a link to it.
    const text = JSON.stringify(document);
    expect(text).not.toContain("ipfs://");
    expect(text).not.toContain("mypinata.cloud");
  }, 60_000);

  it("leaves the prompt out of a sealed generation unless the creator asks for it", async () => {
    const silentMark = pins.length;
    const silent = await generate("did:privy:sealed-prompt-out", drawn("Prompt left out", { sealed: true }));
    expect(silent.statusCode).toBe(200);
    const withoutPrompt = JSON.parse((pinsSince(silentMark)[0] as Pin).bytes.toString("utf8"));
    expect(withoutPrompt.prompt).toBeUndefined();
    expect(JSON.stringify(withoutPrompt)).not.toContain("lighthouse");
    expect(withoutPrompt.model).toBe(MODEL);
    expect(withoutPrompt.generator).toEqual({
      agentId: "10249",
      registry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    });

    const askedMark = pins.length;
    const asked = await generate(
      "did:privy:sealed-prompt-in",
      drawn("Prompt kept", { sealed: true, includePrompt: true }),
    );
    expect(asked.statusCode).toBe(200);
    const withPrompt = JSON.parse((pinsSince(askedMark)[0] as Pin).bytes.toString("utf8"));
    expect(withPrompt.prompt).toBe(PROMPT);
  }, 120_000);

  it("refuses to build a sealed document that carries an image, a thumbnail, a manifest or a key nobody described", () => {
    const good = aSealedDocument();
    expect(sealedMetadataSchema.safeParse(good).success).toBe(true);

    for (const forbidden of ["image", "thumbnail", "manifest", "animation_url"]) {
      const parsed = sealedMetadataSchema.safeParse({ ...good, [forbidden]: "ipfs://bafyleaked" });
      expect(parsed.success, forbidden).toBe(false);
      expect(JSON.stringify(parsed.error?.issues), forbidden).toContain("unrecognized_keys");
    }

    // A key whose value is undefined still counts as a key, which is what stops a leak being
    // written as `image: someUriThatTurnedOutUndefined`.
    expect(sealedMetadataSchema.safeParse({ ...good, thumbnail: undefined }).success).toBe(false);
    expect(sealedMetadataSchema.safeParse({ ...good, sealed: false }).success).toBe(false);

    const wrongAlgorithm = { ...good, commitment: { algorithm: "md5", value: good.commitment.value } };
    expect(sealedMetadataSchema.safeParse(wrongAlgorithm).success).toBe(false);

    const badStatement = { ...good, training: { aiTraining: "sometimes", standard: "cawg.training-mining/1.1" } };
    expect(sealedMetadataSchema.safeParse(badStatement).success).toBe(false);

    const strayInStatement = { ...good, training: { aiTraining: "allowed", note: "x", standard: "cawg.training-mining/1.1" } };
    expect(sealedMetadataSchema.safeParse(strayInStatement).success).toBe(false);
  });

  // Invariant 4: bytes are never cached or logged.
  it("answers no-store and keeps the file out of every log line", async () => {
    const loud = await buildServer({ source: emptySource, logger: true, prepare: { keys: verifying } });
    await loud.ready();

    let captured: string;
    let response: LightMyRequestResponse;
    try {
      const run = await captureLog(
        async () =>
          await prepare(loud, "did:privy:sealed-log", {
            title: "Not in the log",
            kind: "human",
            sealed: "true",
          }),
      );
      response = run.response;
      captured = run.logged;
    } finally {
      await loud.close();
    }

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");

    // The capture has to have caught something, or the rest of this test proves nothing.
    expect(captured).toContain("/prepare");
    expect(captured).toContain("request completed");

    const base64 = response.json().signedFile.bytes as string;
    const raw = Buffer.from(base64, "base64");
    expect(captured).not.toContain(base64.slice(0, 64));
    expect(captured).not.toContain(base64);
    expect(captured).not.toContain(raw.subarray(0, 48).toString("latin1"));
    expect(captured).not.toContain(raw.subarray(raw.length - 48).toString("latin1"));
  }, 60_000);

  // Invariant 3 is the studio's, but it is only possible if the bytes the creator receives really
  // are the bytes the passport id names.
  it("hands back the exact file the passport id commits to, manifest and all", async () => {
    const response = await prepare(app, "did:privy:sealed-bytes", {
      title: "The only copy",
      kind: "human",
      sealed: "true",
    });

    expect(response.statusCode).toBe(200);
    const answer = response.json();
    const file = answer.signedFile;
    const bytes = Buffer.from(file.bytes as string, "base64");

    expect(file.name).toBe(`${fileSlug("The only copy", answer.passport.exactHash)}.jpg`);
    expect(file.type).toBe("image/jpeg");
    expect(file.sha256).toBe(answer.passport.exactHash);
    expect(`0x${createHash("sha256").update(bytes).digest("hex")}`).toBe(file.sha256);

    const manifest = await readManifest(bytes);
    expect(manifest.present).toBe(true);
    expect(manifest.manifestHash).toBe(answer.passport.manifestHash);
    expect(manifest.softBinding?.blockhash).toBe(answer.passport.blockhash256);
    expect(manifest.softBinding?.phash?.toString()).toBe(answer.passport.phash);
  }, 60_000);

  it("registers publicly exactly as before when nothing asks for sealed", async () => {
    const mark = pins.length;
    const response = await prepare(app, "did:privy:public-unchanged", {
      title: "Still public",
      kind: "human",
    });

    expect(response.statusCode).toBe(200);
    const answer = response.json();
    const made = pinsSince(mark);
    expect(made.map((pin) => pin.type)).toEqual([
      "image/jpeg",
      "image/jpeg",
      "application/json",
      "application/json",
    ]);
    expect(answer.sealed).toBeUndefined();
    expect(answer.signedFile).toBeUndefined();
    expect(answer.image.gatewayUrl).toMatch(/^https:\/\/moolam-test\.mypinata\.cloud\/ipfs\//);
    expect(answer.thumbnail.uri).toMatch(/^ipfs:\/\//);
    expect(answer.manifest).toEqual({ embedded: true });
    // Every answer from this route is no-store now, a public registration included: it carries a
    // title and an address a creator sent us, and none of it belongs in a proxy.
    expect(response.headers["cache-control"]).toBe("no-store");

    const metadata = JSON.parse((made[3] as Pin).bytes.toString("utf8"));
    expect(metadata.image).toBe(answer.image.uri);
    expect(metadata.thumbnail).toBe(answer.thumbnail.uri);
    expect(metadata.sealed).toBeUndefined();
    expect(metadata.commitment).toBeUndefined();
  }, 60_000);

  it("says whether the manifest was embedded, in the same words as the public path, and names no pin", async () => {
    const signed = await prepare(app, "did:privy:sealed-manifest", {
      title: "Manifest inside",
      kind: "human",
      sealed: "true",
    });
    expect(signed.statusCode).toBe(200);
    expect(signed.json().manifest).toEqual({ embedded: true });

    // A file this signer will not take still registers, and the creator has to be told, because
    // the copy they are about to hold is the only one there will be.
    const certPath = "/srv/moolam/secrets/chain.cert.pem";
    stubs.embedManifest.mockRejectedValueOnce(
      new SignerRefusedFile(`the signer at ${certPath} would not take this container`),
    );
    const mark = pins.length;
    const unsigned = await prepare(app, "did:privy:sealed-manifest-refused", {
      title: "No manifest inside",
      kind: "human",
      sealed: "true",
    });

    expect(unsigned.statusCode).toBe(200);
    const answer = unsigned.json();
    expect(answer.manifest).toEqual({ embedded: false, reason: NOT_EMBEDDED_REASON });
    expect(answer.passport.manifestHash).toBe(`0x${"00".repeat(32)}`);
    expect(answer.signedFile.sha256).toBe(answer.passport.exactHash);
    expect(unsigned.body).not.toContain(certPath);
    expect(unsigned.body).not.toContain(".pem");

    // The sealed manifest says one thing and names nothing that could be fetched.
    for (const named of ["cid", "uri", "gatewayUrl"]) {
      expect(answer.manifest[named], named).toBeUndefined();
      expect(signed.json().manifest[named], named).toBeUndefined();
    }
    expect(pinsSince(mark).map((pin) => pin.type)).toEqual(["application/json"]);
  }, 120_000);

  it("marks every answer to a sealed request no-store, the refusals as well as the one with the file", async () => {
    const sealedRefusal = await prepare(app, "did:privy:sealed-refusal", {
      title: "   ",
      kind: "human",
      sealed: "true",
    });
    const publicRefusal = await prepare(app, "did:privy:public-refusal", { title: "   ", kind: "human" });

    expect(sealedRefusal.statusCode).toBe(400);
    expect(sealedRefusal.statusCode).toBe(publicRefusal.statusCode);
    expect(sealedRefusal.json()).toEqual(publicRefusal.json());
    expect(sealedRefusal.headers["cache-control"]).toBe("no-store");
    // A public request to the same route gets it too. It used to depend on the route having read
    // the sealed field, which is a thing several answers never get far enough to do.
    expect(publicRefusal.headers["cache-control"]).toBe("no-store");

    const accepted = await prepare(app, "did:privy:sealed-refusal", {
      title: "Kept",
      kind: "human",
      sealed: "true",
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.headers["cache-control"]).toBe("no-store");
  }, 60_000);

  it("marks the answers no handler writes as well: the 401 before the body and the 413 mid-upload", async () => {
    const { payload, headers } = multipart({ title: "No token", kind: "human", sealed: "true" }, IMAGE);
    const noToken = await app.inject({ method: "POST", url: "/prepare", payload, headers });

    expect(noToken.statusCode).toBe(401);
    // The route refuses before it has read a field, so nothing in the handler could have set this.
    expect(noToken.headers["cache-control"]).toBe("no-store");

    const tooBig = await prepare(
      app,
      "did:privy:sealed-too-many-pixels",
      { title: "Far too many pixels", kind: "human", sealed: "true" },
      await makeOversizeImage(),
    );
    expect(tooBig.statusCode).toBe(413);
    expect(tooBig.headers["cache-control"]).toBe("no-store");

    // The hook names three paths and touches nothing else: a probe is meant to be cacheable.
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.headers["cache-control"]).toBeUndefined();
  }, 60_000);

  it("refuses a sealed registration whose file does not match its passport, with nothing pinned", async () => {
    const preparedMark = pins.length;
    stubs.signedFile.mockImplementationOnce(() => {
      throw new Error("the sealed file does not hash to the passport id, so it could never unseal it");
    });
    const prepared = await prepare(app, "did:privy:sealed-file-refused", {
      title: "A file we will not commit to",
      kind: "human",
      sealed: "true",
    });

    expect(prepared.statusCode).toBe(500);
    expect(prepared.json().error).toBe("sealed-file-refused");
    expect(Object.keys(prepared.json()).sort()).toEqual(["error", "reason"]);
    // The check runs before the pin, so the creator is not left holding a passport id that is
    // published on IPFS and commits to a file nobody has.
    expect(pinsSince(preparedMark)).toHaveLength(0);
    expect(prepared.body).not.toContain("could never unseal");

    const drawnMark = pins.length;
    stubs.signedFile.mockImplementationOnce(() => {
      throw new Error("there is no sealed file to hand back");
    });
    const generated = await generate(
      "did:privy:sealed-file-refused-draw",
      drawn("Drawn and not committed to", { sealed: true }),
    );

    expect(generated.statusCode).toBe(500);
    expect(generated.json().error).toBe("sealed-file-refused");
    expect(pinsSince(drawnMark)).toHaveLength(0);
  }, 120_000);

  it("keeps a generation sealed because the creator said so, not because the drawing looks sealed", async () => {
    const actual = await vi.importActual<typeof import("../src/prepare.js")>("../src/prepare.js");
    // A sealed drawing that happens to carry a thumbnail. The answer used to be chosen by looking
    // for that key, so this picture would have been pinned and published against the creator's word.
    stubs.prepareSealed.mockImplementationOnce(async (bytes: Buffer, settings: never) => ({
      ...(await actual.prepareSealed(bytes, settings)),
      thumbnail: Buffer.from("a key the sealed path has no use for"),
    }));

    const mark = pins.length;
    const response = await generate("did:privy:sealed-by-flag", drawn("Sealed whatever the shape", { sealed: true }));

    expect(response.statusCode).toBe(200);
    const answer = response.json();
    expect(answer.sealed).toBe(true);
    expect(answer.image).toBeUndefined();
    expect(answer.thumbnail).toBeUndefined();
    expect(answer.signedFile.sha256).toBe(answer.passport.exactHash);
    expect(pinsSince(mark).map((pin) => pin.type)).toEqual(["application/json"]);
  }, 120_000);

  it("answers sealed-metadata-refused and pins nothing when the record does not fit the sealed shape", async () => {
    const document = aSealedDocument();
    // What a later convenience would do: put the picture back into the record. The builder
    // checks what it hands back, so this is that check doing its job.
    stubs.sealedMetadata.mockImplementationOnce(() =>
      checkedSealedMetadata({ ...document, image: "ipfs://bafyleaked" }),
    );

    const mark = pins.length;
    const response = await prepare(app, "did:privy:sealed-refused-record", {
      title: "A record we will not publish",
      kind: "human",
      sealed: "true",
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual(SEALED_METADATA_REFUSED);
    expect(response.json().error).toBe("sealed-metadata-refused");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(pinsSince(mark)).toHaveLength(0);
    // Which field did not fit stays in the log, and the answer never repeats the leaked value.
    expect(response.body).not.toContain("bafyleaked");
    expect(response.body).not.toContain("image");

    // The same on the drawn path, where the picture has already been made and paid for: still
    // nothing pinned, and the same answer in the same words.
    stubs.sealedMetadata.mockImplementationOnce(() =>
      checkedSealedMetadata({ ...document, thumbnail: "ipfs://bafyleaked" }),
    );
    const drawnMark = pins.length;
    const refusedDraw = await generate("did:privy:sealed-refused-draw", drawn("Drawn and refused", { sealed: true }));

    expect(refusedDraw.statusCode).toBe(500);
    expect(refusedDraw.json()).toEqual(SEALED_METADATA_REFUSED);
    expect(refusedDraw.headers["cache-control"]).toBe("no-store");
    expect(pinsSince(drawnMark)).toHaveLength(0);
  }, 120_000);

  it("refuses a sealed field that says anything but true or false", async () => {
    const mark = pins.length;
    for (const sealed of ["yes", "1", "TRUE", "maybe"]) {
      const response = await prepare(app, "did:privy:sealed-typo", {
        title: "A typo about sealing",
        kind: "human",
        sealed,
      });
      expect(response.statusCode, sealed).toBe(400);
      expect(response.json().error, sealed).toContain("sealed");
    }
    expect(pinsSince(mark)).toHaveLength(0);
  });

  it("counts a sealed generation against the same daily allowance, and refuses it in the same words", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-21T09:00:00Z"));

    const mixed = "did:privy:sealed-quota";
    expect((await generate(mixed, drawn("Mixed one", { sealed: true }))).statusCode).toBe(200);
    expect((await generate(mixed, drawn("Mixed two"))).statusCode).toBe(200);
    const sealedRefusal = await generate(mixed, drawn("Mixed three", { sealed: true }));

    const open = "did:privy:public-quota";
    expect((await generate(open, drawn("Public one"))).statusCode).toBe(200);
    expect((await generate(open, drawn("Public two"))).statusCode).toBe(200);
    const publicRefusal = await generate(open, drawn("Public three"));

    expect(sealedRefusal.statusCode).toBe(429);
    expect(publicRefusal.statusCode).toBe(429);
    expect(sealedRefusal.json()).toEqual(publicRefusal.json());
    expect(sealedRefusal.json()).toEqual({ error: "quota", quota: { used: 2, limit: 2, resetsAt: expect.any(Number) } });
    vi.useRealTimers();
  }, 180_000);
});
