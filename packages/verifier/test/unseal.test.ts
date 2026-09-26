// Covers POST /unseal and GET /unseal/:passportId, written against the sealed promises in
// docs/security/threat-model.md. Each test names the invariant it holds up:
// (5) only the holder unseals, so the wallets come from the Privy user record and ownerOf is read
// at the moment of the request, and neither a stranger nor a caller naming an address gets past
// it; (6) unsealing publishes exactly what was registered, so the sha-256 of the upload must be
// the passport id and the recomputed fingerprint must be the one the chain holds, and nothing is
// pinned when either fails. It also holds the model's two added notes: a passport whose document
// is already public cannot be unsealed again, and a picture whose thumbnail will not fit the
// Chainlink budget is refused rather than published as a passport that can never be re-checked.
// From the private re-check: once the picture is public, a private copy kept for a private re-check
// is deleted by its exact name, /sealed/status reads gone at once, and a lookup or delete that
// fails changes nothing about the answer.
// The picture in the happy path is made by the real sealed pipeline, so the bytes under test are
// the bytes a sealed registration would have handed the creator.
// From the verifier review (V6, V9, V11): GET /unseal asks Pinata only about a registered, sealed
// passport, remembers a miss for a minute and has its own route limit; a public pin counts only
// when Pinata answers with the content id computed here for the bytes sent, on the public network;
// an unseal that published part of the picture says which parts, keeps the private copy, and
// finishes on a retry.
// Does NOT cover a real Pinata pin, a real Privy call or a real chain read: the pins are recorded
// at the fetch layer and the three chain and gateway reads are stubbed. It does not cover the web
// control, which is a later order, and it does not prove Pinata's own name filter, which this
// service does not trust anyway: the exact name is insisted on again on the way out.

import fs from "node:fs";
import { SignJWT, generateKeyPair } from "jose";
import sharp from "sharp";
import { getAddress, type Hex } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { makeImage } from "./helpers.js";

const APP_ID = vi.hoisted(() => {
  const id = "moolamtestapp0000003";
  process.env.PRIVY_APP_ID = id;
  process.env.PINATA_JWT = "test-token-not-a-real-pinata-jwt";
  process.env.PINATA_GATEWAY_URL = "https://moolam-test.mypinata.cloud/ipfs/";
  process.env.EDITS_PER_DAY = "2";
  process.env.GLOBAL_UNSEALS_PER_DAY = "60";
  return id;
});

const stubs = vi.hoisted(() => ({
  readPassport: vi.fn(),
  holderOf: vi.fn(),
  readMetadataDocument: vi.fn(),
  findUnsealRecord: vi.fn(),
  readUnsealRecord: vi.fn(),
  embeddedWallets: vi.fn(),
}));

// The four reads that leave this process are stubbed and everything else in the module, which is
// every check this route actually makes, stays real.
vi.mock("../src/unseal.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/unseal.js")>();
  return {
    ...real,
    readPassport: stubs.readPassport,
    holderOf: stubs.holderOf,
    readMetadataDocument: stubs.readMetadataDocument,
    findUnsealRecord: stubs.findUnsealRecord,
    readUnsealRecord: stubs.readUnsealRecord,
  };
});

vi.mock("../src/auth/wallet.js", () => ({ embeddedWallets: stubs.embeddedWallets }));

vi.mock("../src/generate/privy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/generate/privy.js")>()),
  privy: () => ({}),
}));

const { THUMBNAIL_MAX_BYTES, UNSEAL_THUMBNAIL_TOO_LARGE_REASON, prepareSealed } = await import("../src/prepare.js");
const { globalDay } = await import("../src/limits/globalDay.js");
const { sealedMetadata } = await import("../src/sealed.js");
const { buildServer } = await import("../src/server.js");
const { fingerprint } = await import("../src/fingerprint.js");
const { contentIdOf } = await import("../src/ipfs/pinata.js");
// The real module, so the pure checks and the record lookup are tested rather than the stubs.
const unseal = await vi.importActual<typeof import("../src/unseal.js")>("../src/unseal.js");

const UPLOAD_URL = "https://uploads.pinata.cloud/v3/files";
const PRIVATE_FILES_URL = "https://api.pinata.cloud/v3/files/private";
const HOLDER = getAddress("0x85a88ca81ff5f681d96ab86fa60ccb8452a139a6");
const STRANGER = getAddress("0x1111111111111111111111111111111111111111");
const METADATA_URI = "ipfs://bafysealeddocument";
const emptySource = { load: async () => [] };

interface Pin {
  name: string;
  type: string;
  bytes: Buffer;
}

const pins: Pin[] = [];
/** Names whose pin is refused, so a test can fail the record alone and leave the picture public. */
let refusePin: (name: string) => boolean = () => false;
/** Lets a test answer one pin with Pinata's own fields bent, for the V11 checks. */
let bendPin: (name: string) => { cid?: string; network?: string } = () => ({});

/** The private files on the stub account, and what the private half of Pinata was asked. */
const privateFiles: { id: string; name: string; cid: string }[] = [];
const privateDeleted: string[] = [];
const privatePinata = { listFails: false, deleteFails: false };
let privateCounter = 0;

function keepPrivate(name: string): { id: string; name: string; cid: string } {
  privateCounter += 1;
  const file = {
    id: `0199a3c2-5d7e-7f10-9a1b-${privateCounter.toString(16).padStart(12, "0")}`,
    name,
    cid: `bafkreiprivate${privateCounter.toString().padStart(30, "0")}`,
  };
  privateFiles.push(file);
  return file;
}

/**
 * The private listing and delete at the fetch layer. The listing answers every name that starts
 * with the filter, looser than any real filter, so the exact-name check in the route is what runs.
 */
function privateAnswer(url: string, method: string): Response | undefined {
  if (url.startsWith(`${PRIVATE_FILES_URL}?`) && method === "GET") {
    if (privatePinata.listFails) return new Response("down", { status: 500 });
    const name = new URL(url).searchParams.get("name") ?? "";
    const files = privateFiles
      .filter((file) => file.name.startsWith(name))
      .map((file) => ({ ...file, created_at: "2026-09-23T08:00:00Z" }));
    return new Response(JSON.stringify({ data: { files, next_page_token: "" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (url.startsWith(`${PRIVATE_FILES_URL}/`) && method === "DELETE") {
    if (privatePinata.deleteFails) return new Response("down", { status: 500 });
    const id = url.slice(PRIVATE_FILES_URL.length + 1);
    privateDeleted.push(id);
    const at = privateFiles.findIndex((file) => file.id === id);
    if (at !== -1) privateFiles.splice(at, 1);
    return new Response(JSON.stringify({ data: null }), { status: 200 });
  }
  return undefined;
}

let signing: CryptoKey;
let verifying: CryptoKey;
let app: FastifyInstance;
/** The signed file a sealed registration would have handed back, and the facts that go with it. */
let sealedFile: { bytes: Buffer; passportId: Hex; phash: bigint; blockhash: Hex };
let sealedDocument: unknown;

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

function unsealBody(
  fields: Record<string, string>,
  file: Buffer,
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = "----moolamunseal";
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="sealed.jpg"\r\n` +
        "Content-Type: image/jpeg\r\n\r\n",
    ),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return { payload: Buffer.concat(chunks), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

async function ask(
  subject: string,
  options: { file?: Buffer; passportId?: string; auth?: boolean; on?: FastifyInstance } = {},
): Promise<LightMyRequestResponse> {
  const { payload, headers } = unsealBody(
    { passportId: options.passportId ?? sealedFile.passportId },
    options.file ?? sealedFile.bytes,
  );
  return await (options.on ?? app).inject({
    method: "POST",
    url: "/unseal",
    payload,
    headers: {
      ...headers,
      ...(options.auth === false ? {} : { authorization: `Bearer ${await token(subject)}` }),
    },
    remoteAddress: "198.51.100.44",
  });
}

/** A picture of pure noise, which is the one thing a 512 pixel thumbnail cannot compress. */
async function makeNoiseImage(): Promise<Buffer> {
  const side = 512;
  const raw = Buffer.alloc(side * side * 3);
  let state = 12345;
  for (let i = 0; i < raw.length; i += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    raw[i] = (state >> 16) & 0xff;
  }
  return await sharp(raw, { raw: { width: side, height: side, channels: 3 } }).jpeg({ quality: 100 }).toBuffer();
}

/** Everything this service writes to the console while `work` runs, by both roads pino uses. */
async function captureLog(
  work: () => Promise<LightMyRequestResponse>,
): Promise<{ response: LightMyRequestResponse; logged: string }> {
  const lines: string[] = [];
  const keep = (chunk: unknown): void => {
    if (typeof chunk === "string") lines.push(chunk);
    else if (chunk instanceof Uint8Array) lines.push(Buffer.from(chunk).toString("utf8"));
  };

  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    keep(chunk);
    return true;
  });
  const realWrite = fs.write;
  const patched = fs as unknown as Record<string, unknown>;
  patched.write = (...args: unknown[]): unknown => {
    if (args[0] === 1) keep(args[1]);
    return (realWrite as unknown as (...rest: unknown[]) => unknown)(...args);
  };

  try {
    const response = await work();
    await new Promise((resolve) => setTimeout(resolve, 150));
    return { response, logged: lines.join("") };
  } finally {
    patched.write = realWrite;
    stdout.mockRestore();
  }
}

describe("unsealing a sealed passport", () => {
  beforeAll(async () => {
    const pair = await generateKeyPair("ES256", { extractable: true });
    signing = pair.privateKey;
    verifying = pair.publicKey;

    // The real sealed pipeline, so the file under test is the file a creator would be holding.
    const prepared = await prepareSealed(
      await sharp({
        create: { width: 640, height: 480, channels: 3, background: "#1d3b53" },
      })
        .jpeg({ quality: 92 })
        .toBuffer(),
      { title: "Monsoon nets, sealed", claimGenerator: "moolam-studio/0.1.0", action: "c2pa.created" },
    );
    sealedFile = {
      bytes: prepared.bytes,
      passportId: prepared.print.sha256,
      phash: prepared.print.phash,
      blockhash: prepared.print.blockhash,
    };
    sealedDocument = sealedMetadata({
      title: "Monsoon nets, sealed",
      description: "A picture registered with Moolam and kept sealed.",
      passportId: sealedFile.passportId,
      fingerprint: prepared.print,
    });

    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const privately = privateAnswer(url, init?.method ?? "GET");
      if (privately !== undefined) {
        return privately;
      }
      if (url !== UPLOAD_URL) {
        return await realFetch(input, init);
      }
      const form = init?.body as FormData;
      const name = String(form.get("name"));
      if (refusePin(name)) {
        return new Response("pinata said no", { status: 400 });
      }
      const file = form.get("file") as File;
      const bytes = Buffer.from(await file.arrayBuffer());
      pins.push({ name, type: file.type, bytes });
      const answer = { cid: contentIdOf(bytes), size: bytes.length, network: "public", ...bendPin(name) };
      return new Response(JSON.stringify({ data: answer }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    app = await buildServer({ source: emptySource, logger: false, unseal: { keys: verifying } });
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    await app.close();
  });

  beforeEach(() => {
    pins.length = 0;
    refusePin = () => false;
    bendPin = () => ({});
    privateFiles.length = 0;
    privateDeleted.length = 0;
    privatePinata.listFails = false;
    privatePinata.deleteFails = false;
    stubs.readPassport.mockReset().mockResolvedValue({
      registeredAt: 1_758_000_000,
      phash: sealedFile.phash,
      blockhash256: sealedFile.blockhash,
      fingerprintVersion: 1,
      metadataURI: METADATA_URI,
    });
    stubs.holderOf.mockReset().mockResolvedValue(HOLDER);
    stubs.embeddedWallets.mockReset().mockResolvedValue([HOLDER]);
    stubs.readMetadataDocument.mockReset().mockResolvedValue(sealedDocument);
    stubs.findUnsealRecord.mockReset().mockResolvedValue({ state: "none" });
    stubs.readUnsealRecord.mockReset();
  });

  it("publishes the picture, its thumbnail, its manifest and the record, in that order", async () => {
    const response = await ask("did:privy:unseal-happy");

    expect(response.statusCode).toBe(200);
    const answer = response.json();

    expect(pins).toHaveLength(4);
    expect(pins.slice(0, 3).map((pin) => pin.type).sort()).toEqual([
      "application/json",
      "image/jpeg",
      "image/jpeg",
    ]);
    expect((pins[3] as Pin).name).toBe(`unseal-${sealedFile.passportId}.json`);

    // Invariant 6 as a reader checks it: the bytes on IPFS hash to the passport id.
    const picture = pins.find((pin) => pin.name.endsWith(".jpg") && !pin.name.includes("thumb")) as Pin;
    expect(unseal.sha256Of(picture.bytes)).toBe(sealedFile.passportId);
    expect(picture.bytes.equals(sealedFile.bytes)).toBe(true);

    const record = JSON.parse((pins[3] as Pin).bytes.toString("utf8")) as Record<string, unknown>;
    expect(record.passportId).toBe(sealedFile.passportId);
    expect(record.image).toBe(answer.image.uri);
    expect(record.thumbnail).toBe(answer.thumbnail.uri);
    expect(record.manifest).toBe(answer.manifest.uri);
    expect(record.unsealedBy).toBe(HOLDER);
    expect(unseal.unsealRecordSchema.safeParse(record).success).toBe(true);

    expect(answer.passportId).toBe(sealedFile.passportId);
    expect(answer.image.gatewayUrl).toMatch(/^https:\/\/moolam-test\.mypinata\.cloud\/ipfs\//);
    expect(answer.record.uri).toMatch(/^ipfs:\/\/.+/);
    expect(answer.quota).toEqual({ used: 1, limit: 2, resetsAt: expect.any(Number) });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(JSON.stringify(answer)).not.toContain("test-token-not-a-real-pinata-jwt");
  }, 60_000);

  it("refuses a request with no token before it reads the chain or Privy", async () => {
    const response = await ask("did:privy:unseal-no-token", { auth: false });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "unauthorized" });
    expect(stubs.readPassport).not.toHaveBeenCalled();
    expect(stubs.embeddedWallets).not.toHaveBeenCalled();
    expect(pins).toHaveLength(0);
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("refuses a missing file and a passport id that is not 32 bytes of hex", async () => {
    const bad = await ask("did:privy:unseal-bad-id", { passportId: "0xnothex" });
    expect(bad.statusCode).toBe(400);

    const { payload, headers } = unsealBody({ passportId: sealedFile.passportId }, Buffer.alloc(0));
    const empty = await app.inject({
      method: "POST",
      url: "/unseal",
      payload,
      headers: { ...headers, authorization: `Bearer ${await token("did:privy:unseal-no-file")}` },
    });
    expect(empty.statusCode).toBe(400);
    expect(pins).toHaveLength(0);
  });

  // Invariant 6: a different picture publishes nothing, whoever is asking.
  it("answers hash-mismatch for a file that is not the registered one, and pins nothing", async () => {
    const response = await ask("did:privy:unseal-other-file", { file: await makeNoiseImage() });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "hash-mismatch", passportId: sealedFile.passportId });
    expect(pins).toHaveLength(0);
    expect(stubs.holderOf).not.toHaveBeenCalled();
  }, 60_000);

  // Invariant 4 reaches this route too: a refused unseal holds a picture that is still private,
  // and the log line about the refusal must not be where it becomes public.
  it("writes no part of a refused picture to the log", async () => {
    const talkative = await buildServer({ source: emptySource, logger: true, unseal: { keys: verifying } });
    await talkative.ready();
    const picture = await makeNoiseImage();

    try {
      const { response, logged } = await captureLog(
        async () => await ask("did:privy:unseal-quiet-log", { file: picture, on: talkative }),
      );

      expect(response.statusCode).toBe(400);
      expect(logged.length).toBeGreaterThan(0);
      expect(logged).toContain("rejected");
      expect(logged).not.toContain(picture.toString("base64").slice(0, 64));
      expect(logged).not.toContain(picture.subarray(0, 32).toString("hex"));
    } finally {
      await talkative.close();
    }
  }, 60_000);

  // Invariant 6, second half.
  it("answers fingerprint-mismatch when the chain's fingerprint is not the one recomputed", async () => {
    stubs.readPassport.mockResolvedValue({
      registeredAt: 1_758_000_000,
      phash: sealedFile.phash + 1n,
      blockhash256: sealedFile.blockhash,
      fingerprintVersion: 1,
      metadataURI: METADATA_URI,
    });

    const response = await ask("did:privy:unseal-print-moved");

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("fingerprint-mismatch");
    expect(pins).toHaveLength(0);
  }, 60_000);

  // Invariant 5.
  it("answers not-holder when the registry says another wallet holds the passport", async () => {
    stubs.holderOf.mockResolvedValue(STRANGER);

    const response = await ask("did:privy:unseal-stranger");

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "not-holder" });
    expect(pins).toHaveLength(0);
  }, 60_000);

  it("answers not-holder for a Privy user this app does not know", async () => {
    const { APIError } = await import("@privy-io/node");
    stubs.embeddedWallets.mockRejectedValueOnce(new APIError(404, { code: "not_found" }, "no user", undefined));

    const response = await ask("did:privy:unseal-unknown-user");

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "not-holder" });
    expect(pins).toHaveLength(0);
  }, 60_000);

  it("answers no-passport for an id the registry does not hold", async () => {
    stubs.readPassport.mockResolvedValue(undefined);

    const response = await ask("did:privy:unseal-unknown-passport");

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe("no-passport");
    expect(stubs.embeddedWallets).not.toHaveBeenCalled();
    expect(pins).toHaveLength(0);
  }, 60_000);

  it("answers not-sealed when the passport's document is public already", async () => {
    stubs.readMetadataDocument.mockResolvedValue({ name: "A public picture", image: "ipfs://bafypublic" });

    const response = await ask("did:privy:unseal-public");

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("not-sealed");
    expect(pins).toHaveLength(0);
  }, 60_000);

  it("answers already-unsealed, with the record, when one is pinned for this passport", async () => {
    stubs.findUnsealRecord.mockResolvedValue({
      state: "found",
      record: { cid: "bafyexisting", uri: "ipfs://bafyexisting" },
    });

    const response = await ask("did:privy:unseal-twice");

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("already-unsealed");
    expect(response.json().record.cid).toBe("bafyexisting");
    expect(pins).toHaveLength(0);
  }, 60_000);

  it("goes on when the record lookup cannot answer, because every pin lands on the same address", async () => {
    stubs.findUnsealRecord.mockResolvedValue({ state: "unavailable", reason: "pinata is down" });

    const response = await ask("did:privy:unseal-lookup-down");

    expect(response.statusCode).toBe(200);
    expect(pins).toHaveLength(4);
  }, 60_000);

  // The threat model's own note: the sealed path makes no thumbnail, so this picture could be
  // registered sealed although the public path would have refused it.
  it("refuses a picture whose thumbnail cannot fit the Chainlink budget, and pins nothing", async () => {
    const noise = await makeNoiseImage();
    const print = await fingerprint(noise);
    stubs.readPassport.mockResolvedValue({
      registeredAt: 1_758_000_000,
      phash: print.phash,
      blockhash256: print.blockhash,
      fingerprintVersion: 1,
      metadataURI: METADATA_URI,
    });

    const response = await ask("did:privy:unseal-fat-thumbnail", { file: noise, passportId: print.sha256 });

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe("thumbnail-too-large");
    expect(response.json().limit).toBe(THUMBNAIL_MAX_BYTES);
    // The same sentence a public /prepare answers with, so one code always carries one reason.
    expect(response.json().reason).toBe(UNSEAL_THUMBNAIL_TOO_LARGE_REASON);
    expect(pins).toHaveLength(0);
  }, 60_000);

  it("stops a creator at their own daily allowance and pins nothing on the refusal", async () => {
    const user = "did:privy:unseal-quota";
    expect((await ask(user)).statusCode).toBe(200);
    expect((await ask(user)).statusCode).toBe(200);

    pins.length = 0;
    const refused = await ask(user);

    expect(refused.statusCode).toBe(429);
    expect(refused.json().error).toBe("quota");
    expect(refused.json().quota).toEqual({ used: 2, limit: 2, resetsAt: expect.any(Number) });
    expect(pins).toHaveLength(0);
    expect(refused.headers["cache-control"]).toBe("no-store");
  }, 120_000);

  it("refuses everyone once today's ceiling for unseals is spent", async () => {
    const closed = await buildServer({ source: emptySource, logger: false, unseal: { keys: verifying } });
    closed.globalDay = globalDay({ prepares: 5, generations: 5, edits: 5, unseals: 0, links: 5 });
    await closed.ready();

    try {
      const refused = await ask("did:privy:unseal-ceiling", { on: closed });

      expect(refused.statusCode).toBe(429);
      expect(refused.json().error).toBe("global-limit");
      expect(refused.headers["retry-after"]).toMatch(/^[0-9]+$/);
      expect(pins).toHaveLength(0);
    } finally {
      await closed.close();
    }
  }, 60_000);

  it("gives the day's slot back when the request pinned nothing", async () => {
    const before = (await app.inject({ method: "GET", url: "/health" })).json().limits.unseals.used as number;
    stubs.readMetadataDocument.mockResolvedValue({ name: "A public picture", image: "ipfs://bafypublic" });

    expect((await ask("did:privy:unseal-slot-back")).statusCode).toBe(409);

    const after = (await app.inject({ method: "GET", url: "/health" })).json().limits.unseals.used as number;
    expect(after).toBe(before);
  }, 60_000);

  it("answers chain-unavailable when the registry read does not come back", async () => {
    stubs.readPassport.mockRejectedValue(new Error("fetch failed"));

    const response = await ask("did:privy:unseal-chain-down");

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "chain-unavailable" });
    expect(pins).toHaveLength(0);
  }, 60_000);

  it("answers metadata-unavailable rather than guessing when the sealed document cannot be read", async () => {
    stubs.readMetadataDocument.mockRejectedValue(new Error("the gateway answered 504"));

    const response = await ask("did:privy:unseal-gateway-down");

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "metadata-unavailable" });
    expect(pins).toHaveLength(0);
  }, 60_000);

  it("answers pin-failed when nothing reached IPFS", async () => {
    refusePin = () => true;

    const response = await ask("did:privy:unseal-pin-down");

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      error: "pin-failed",
      passportId: sealedFile.passportId,
      published: {},
      failed: ["image", "thumbnail", "manifest"],
    });
    expect(pins).toHaveLength(0);
  }, 60_000);

  // V9: a partial unseal says what is public, keeps the private copy, and finishes on a retry.
  it("names what landed when the picture's pin failed, keeps the private copy, and a retry finishes it", async () => {
    const id = sealedFile.passportId;
    const kept = keepPrivate(`sealed-thumb-${id}.jpg`);
    const user = "did:privy:unseal-partial";
    refusePin = (name) => name.endsWith(".jpg") && !name.endsWith("-thumb.jpg");

    const partial = await ask(user);

    expect(partial.statusCode).toBe(502);
    const said = partial.json();
    expect(said.error).toBe("pin-failed");
    expect(said.failed).toEqual(["image"]);
    expect(Object.keys(said.published).sort()).toEqual(["manifest", "thumbnail"]);
    expect(said.published.thumbnail.uri).toBe(`ipfs://${said.published.thumbnail.cid}`);
    expect(said.reason).toMatch(/Send the same file again/);
    expect(pins.some((pin) => pin.name.startsWith("unseal-"))).toBe(false);
    expect(privateDeleted).toEqual([]);

    refusePin = () => false;
    const finished = await ask(user);

    expect(finished.statusCode).toBe(200);
    const done = finished.json();
    expect(done.thumbnail.cid).toBe(said.published.thumbnail.cid);
    expect(done.manifest.cid).toBe(said.published.manifest.cid);
    expect(privateDeleted).toEqual([kept.id]);
    // The half-done attempt did not cost the holder their allowance.
    expect(done.quota.used).toBe(1);
  }, 120_000);

  // V11: Pinata's answer is checked against the bytes, before anything private is deleted.
  it("refuses a pin whose content id is not the one computed for the bytes sent, and deletes nothing private", async () => {
    const id = sealedFile.passportId;
    const kept = keepPrivate(`sealed-thumb-${id}.jpg`);
    bendPin = (name) => (name.endsWith("-thumb.jpg") ? { cid: "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku" } : {});

    const response = await ask("did:privy:unseal-wrong-cid");

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ error: "pin-failed", failed: ["thumbnail"] });
    expect(response.json().published.thumbnail).toBeUndefined();
    expect(pins.some((pin) => pin.name.startsWith("unseal-"))).toBe(false);
    expect(privateDeleted).toEqual([]);
    expect(privateFiles).toEqual([kept]);
  }, 60_000);

  it("refuses a public pin Pinata answered from its private network, and deletes nothing private", async () => {
    const id = sealedFile.passportId;
    const kept = keepPrivate(`sealed-thumb-${id}.jpg`);
    bendPin = (name) => (name.endsWith("-thumb.jpg") ? { network: "private" } : {});

    const response = await ask("did:privy:unseal-private-duplicate");

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ error: "pin-failed", failed: ["thumbnail"] });
    expect(privateDeleted).toEqual([]);
    expect(privateFiles).toEqual([kept]);
  }, 60_000);

  it("says what is already public when the picture landed and the record did not", async () => {
    refusePin = (name) => name.startsWith("unseal-");

    const response = await ask("did:privy:unseal-record-down");

    expect(response.statusCode).toBe(502);
    const answer = response.json();
    expect(answer.error).toBe("record-pin-failed");
    expect(answer.image.uri).toMatch(/^ipfs:\/\/.+/);
    expect(answer.thumbnail.uri).toMatch(/^ipfs:\/\/.+/);
    expect(answer.reason).toContain("published");
    expect(pins).toHaveLength(3);
  }, 60_000);

  it("deletes the private copy by its exact name once the picture is public, and /sealed/status reads gone at once", async () => {
    const id = sealedFile.passportId;
    stubs.readMetadataDocument.mockResolvedValue(
      sealedMetadata({
        title: "Monsoon nets, sealed",
        description: "A picture registered with Moolam and kept sealed.",
        passportId: id,
        fingerprint: { sha256: id, phash: sealedFile.phash, blockhash: sealedFile.blockhash, width: 640, height: 480, format: "jpeg" },
        privateRecheck: true,
      }),
    );
    const kept = keepPrivate(`sealed-thumb-${id}.jpg`);
    const lookalike = keepPrivate(`sealed-thumb-${id}.jpg.old`);
    const status = async (): Promise<LightMyRequestResponse> =>
      await app.inject({ method: "GET", url: `/sealed/status/${id}`, remoteAddress: "198.51.100.45" });

    expect((await status()).json().state).toBe("kept");
    const response = await ask("did:privy:unseal-private-copy");

    expect(response.statusCode).toBe(200);
    expect(pins).toHaveLength(4);
    expect(privateDeleted).toEqual([kept.id]);
    expect(privateFiles).toEqual([lookalike]);
    expect(response.body).not.toContain(kept.id);
    // Without the drop, the status memory would go on saying kept for the rest of its minute.
    expect((await status()).json()).toEqual({ passportId: id, state: "gone", privateRecheck: true });
  }, 60_000);

  it("answers exactly as before when the private delete or the lookup fails, and logs the passport id", async () => {
    const id = sealedFile.passportId;
    const kept = keepPrivate(`sealed-thumb-${id}.jpg`);
    const loud = await buildServer({ source: emptySource, logger: true, unseal: { keys: verifying } });
    await loud.ready();
    try {
      privatePinata.deleteFails = true;
      const deleteDown = await captureLog(async () => await ask("did:privy:unseal-delete-down", { on: loud }));
      privatePinata.deleteFails = false;
      privatePinata.listFails = true;
      const lookupDown = await captureLog(async () => await ask("did:privy:unseal-lookup-private-down", { on: loud }));

      for (const { response } of [deleteDown, lookupDown]) {
        expect(response.statusCode).toBe(200);
        const answer = response.json();
        expect(answer.error).toBeUndefined();
        expect(answer.passportId).toBe(id);
        expect(answer.record.uri).toMatch(/^ipfs:\/\/.+/);
        expect(response.body).not.toContain("private");
      }
      expect(privateFiles).toEqual([kept]);
      const partly = deleteDown.logged.split("\n").find((line) => line.includes("only partly deleted")) ?? "";
      expect(partly).toContain(id);
      expect(partly).not.toContain(kept.id);
      const notLooked = lookupDown.logged.split("\n").find((line) => line.includes("could not look for a private copy")) ?? "";
      expect(notLooked).toContain(id);
    } finally {
      await loud.close();
    }
  }, 120_000);
});

describe("GET /unseal/:passportId", () => {
  let reader: FastifyInstance;

  beforeAll(async () => {
    reader = await buildServer({ source: emptySource, logger: false, unseal: { keys: verifying } });
    await reader.ready();
  });

  afterAll(async () => {
    await reader.close();
  });

  beforeEach(() => {
    stubs.findUnsealRecord.mockReset().mockResolvedValue({ state: "none" });
    stubs.readUnsealRecord.mockReset();
    // Only the passport's existence and its document's sealed flag matter to this route.
    stubs.readPassport.mockReset().mockResolvedValue({
      registeredAt: 1_758_000_000,
      phash: 1n,
      blockhash256: `0x${"00".repeat(32)}`,
      fingerprintVersion: 1,
      metadataURI: METADATA_URI,
    });
    stubs.readMetadataDocument.mockReset().mockResolvedValue({ name: "Monsoon nets, sealed", sealed: true });
  });

  async function read(id: string, from = "198.51.100.45"): Promise<LightMyRequestResponse> {
    return await reader.inject({ method: "GET", url: `/unseal/${id}`, remoteAddress: from });
  }

  // V6: a made-up id costs a chain read at most, never a Pinata request.
  it("answers no-passport for an id nobody registered, without asking Pinata", async () => {
    stubs.readPassport.mockResolvedValue(undefined);

    const response = await read(`0x${"5e".repeat(32)}`);

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "no-passport", passportId: `0x${"5e".repeat(32)}` });
    expect(stubs.findUnsealRecord).not.toHaveBeenCalled();
  });

  it("answers not-sealed for a passport whose picture was always public, without asking Pinata", async () => {
    stubs.readMetadataDocument.mockResolvedValue({ name: "A public picture", image: "ipfs://bafypublic" });

    const response = await read(`0x${"5f".repeat(32)}`);

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe("not-sealed");
    expect(stubs.findUnsealRecord).not.toHaveBeenCalled();
  });

  it("remembers a miss for a while, so asking again costs no second Pinata request", async () => {
    const id = `0x${"60".repeat(32)}`;

    expect((await read(id)).json().error).toBe("not-unsealed");
    expect((await read(id)).json().error).toBe("not-unsealed");
    stubs.readPassport.mockResolvedValue(undefined);
    const made = `0x${"61".repeat(32)}`;
    expect((await read(made)).statusCode).toBe(404);
    expect((await read(made)).statusCode).toBe(404);

    expect(stubs.findUnsealRecord).toHaveBeenCalledTimes(1);
    expect(stubs.readPassport).toHaveBeenCalledTimes(2);
  });

  it("gives the route its own limit of 30 a minute per address", async () => {
    stubs.readPassport.mockResolvedValue(undefined);
    const answers: number[] = [];
    for (let i = 0; i < 31; i += 1) {
      answers.push((await read(`0x${(0x80 + i).toString(16).repeat(32)}`, "198.51.100.99")).statusCode);
    }

    expect(answers.slice(0, 30).every((status) => status === 404)).toBe(true);
    expect(answers[30]).toBe(429);
  });

  it("refuses an id that is not 32 bytes of hex", async () => {
    const response = await read("0xnothex");
    expect(response.statusCode).toBe(400);
    expect(stubs.findUnsealRecord).not.toHaveBeenCalled();
  });

  it("answers not-unsealed for a passport with no record, and never caches the answer", async () => {
    const response = await read(`0x${"ab".repeat(32)}`);

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe("not-unsealed");
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("answers the three addresses and the record when one is pinned", async () => {
    const id = `0x${"cd".repeat(32)}` as Hex;
    stubs.findUnsealRecord.mockResolvedValue({
      state: "found",
      record: { cid: "bafyrecord", uri: "ipfs://bafyrecord", createdAt: "2026-09-22T10:00:00Z" },
    });
    stubs.readUnsealRecord.mockResolvedValue(
      unseal.unsealRecord({
        passportId: id,
        image: "ipfs://bafypicture",
        thumbnail: "ipfs://bafythumb",
        manifest: "ipfs://bafymanifest",
        unsealedBy: HOLDER,
        unsealedAt: new Date("2026-09-22T09:59:00Z"),
      }),
    );

    const response = await read(id);

    expect(response.statusCode).toBe(200);
    const answer = response.json();
    expect(answer.passportId).toBe(id);
    expect(answer.image).toEqual({
      cid: "bafypicture",
      uri: "ipfs://bafypicture",
      gatewayUrl: "https://moolam-test.mypinata.cloud/ipfs/bafypicture",
    });
    expect(answer.record.cid).toBe("bafyrecord");
    expect(answer.unsealedBy).toBe(HOLDER);
    expect(answer.unsealedAt).toBe("2026-09-22T09:59:00.000Z");
    expect(response.headers["cache-control"]).toBe("no-store");

    // The second read is served from this server's memory: a pinned record never changes.
    const again = await read(id);
    expect(again.statusCode).toBe(200);
    expect(stubs.findUnsealRecord).toHaveBeenCalledTimes(1);
  });

  it("says it cannot tell, and asks nobody else, when the passport's document cannot be read", async () => {
    stubs.readMetadataDocument.mockRejectedValue(new Error("the gateway answered 504"));

    const response = await read(`0x${"62".repeat(32)}`);

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "lookup-unavailable" });
    expect(stubs.findUnsealRecord).not.toHaveBeenCalled();
  });

  it("says it cannot tell, rather than not-unsealed, when the lookup does not answer", async () => {
    stubs.findUnsealRecord.mockResolvedValue({ state: "unavailable", reason: "pinata is down" });

    const response = await read(`0x${"ef".repeat(32)}`);

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "lookup-unavailable" });
  });

  it("says it cannot tell when a file is listed under the name but is not a record", async () => {
    stubs.findUnsealRecord.mockResolvedValue({
      state: "found",
      record: { cid: "bafyjunk", uri: "ipfs://bafyjunk" },
    });
    stubs.readUnsealRecord.mockRejectedValue(new Error("not an unseal record"));

    const response = await read(`0x${"12".repeat(32)}`);

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "lookup-unavailable" });
  });

  it("asks the reader for this passport, so a record about another one cannot be shown here", async () => {
    const id = `0x${"34".repeat(32)}` as Hex;
    stubs.findUnsealRecord.mockResolvedValue({
      state: "found",
      record: { cid: "bafyother", uri: "ipfs://bafyother" },
    });
    stubs.readUnsealRecord.mockResolvedValue(
      unseal.unsealRecord({
        passportId: id,
        image: "ipfs://bafypicture",
        thumbnail: "ipfs://bafythumb",
        unsealedBy: HOLDER,
      }),
    );

    expect((await read(id)).statusCode).toBe(200);
    expect(stubs.readUnsealRecord.mock.lastCall?.[1]).toBe(id);
  });
});

describe("the unseal checks on their own", () => {
  const passportId = `0x${"7a".repeat(32)}` as Hex;

  it("names a record file from the passport id alone, the same way every time", () => {
    expect(unseal.unsealRecordName(passportId)).toBe(`unseal-${passportId}.json`);
    expect(unseal.unsealRecordName(passportId.toUpperCase().replace("0X", "0x") as Hex)).toBe(
      unseal.unsealRecordName(passportId),
    );
  });

  it("hashes bytes the way the registry does", () => {
    expect(unseal.sha256Of(Buffer.from("moolam"))).toMatch(/^0x[0-9a-f]{64}$/);
    expect(unseal.sha256Of(Buffer.from("moolam"))).toBe(unseal.sha256Of(Buffer.from("moolam")));
    expect(unseal.sha256Of(Buffer.from("moolam"))).not.toBe(unseal.sha256Of(Buffer.from("moolaM")));
  });

  it("matches a fingerprint only when both hashes and the version agree", async () => {
    // A picture with real structure, so the block hash is not the all-zero one a flat colour gives
    // and the wrong-hash case below is a genuine disagreement.
    const print = await fingerprint(await makeImage(7));
    const chain = {
      registeredAt: 1,
      phash: print.phash,
      blockhash256: print.blockhash,
      fingerprintVersion: 1,
      metadataURI: METADATA_URI,
    };

    expect(unseal.fingerprintMatches(print, chain)).toBe(true);
    expect(unseal.fingerprintMatches(print, { ...chain, phash: print.phash + 1n })).toBe(false);
    expect(unseal.fingerprintMatches(print, { ...chain, blockhash256: `0x${"00".repeat(32)}` })).toBe(false);
    expect(unseal.fingerprintMatches(print, { ...chain, fingerprintVersion: 2 })).toBe(false);
  }, 30_000);

  it("reads a document as sealed, public or unreadable, and never guesses", () => {
    expect(unseal.sealedStateOf({ sealed: true })).toBe("sealed");
    expect(unseal.sealedStateOf({ sealed: false })).toBe("public");
    expect(unseal.sealedStateOf({ image: "ipfs://x" })).toBe("public");
    expect(unseal.sealedStateOf({ sealed: "true" })).toBe("unreadable");
    expect(unseal.sealedStateOf(null)).toBe("unreadable");
    expect(unseal.sealedStateOf("sealed")).toBe("unreadable");
  });

  it("applies the public path's thumbnail rule to a picture the sealed path let through", async () => {
    const fits = await unseal.unsealThumbnail(
      await sharp({ create: { width: 640, height: 480, channels: 3, background: "#1d3b53" } })
        .jpeg()
        .toBuffer(),
    );
    expect(fits.ok).toBe(true);
    if (fits.ok) expect(fits.thumbnail.length).toBeLessThanOrEqual(THUMBNAIL_MAX_BYTES);

    const refused = await unseal.unsealThumbnail(await makeNoiseImage());
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.limit).toBe(THUMBNAIL_MAX_BYTES);
  }, 60_000);

  it("refuses to build a record that does not fit the shape it publishes", () => {
    const good = unseal.unsealRecord({
      passportId,
      image: "ipfs://bafyimage",
      thumbnail: "ipfs://bafythumb",
      unsealedBy: HOLDER,
    });
    expect(good.manifest).toBeUndefined();
    expect(good.note).toBe(unseal.UNSEAL_RECORD_NOTE);

    expect(() =>
      unseal.unsealRecord({
        passportId,
        image: "https://example.com/picture.jpg",
        thumbnail: "ipfs://bafythumb",
        unsealedBy: HOLDER,
      }),
    ).toThrow(unseal.UnsealRecordRefused);

    expect(unseal.unsealRecordSchema.safeParse({ ...good, creatorEmail: "someone@example.com" }).success).toBe(
      false,
    );
  });

  describe("reading a pinned record back", () => {
    /** safeFetch with the name resolution and the socket replaced, so no packet leaves the box. */
    function served(body: unknown, status = 200) {
      return {
        resolve: async () => ["93.184.216.34"],
        transport: (async () =>
          new Response(JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
          })) as never,
      };
    }

    const record = unseal.unsealRecord({
      passportId,
      image: "ipfs://bafyimage",
      thumbnail: "ipfs://bafythumb",
      unsealedBy: HOLDER,
    });

    it("hands back a record that fits the shape and names this passport", async () => {
      const read = await unseal.readUnsealRecord("ipfs://bafyrecord", passportId, served(record));
      expect(read).toEqual(record);
    });

    it("refuses a record about another passport, whatever it was pinned under", async () => {
      const other = `0x${"9b".repeat(32)}` as Hex;
      await expect(unseal.readUnsealRecord("ipfs://bafyrecord", other, served(record))).rejects.toThrow(
        unseal.UnsealRecordRefused,
      );
    });

    it("refuses a file that is not a record at all, and a gateway that will not serve one", async () => {
      await expect(
        unseal.readUnsealRecord("ipfs://bafyjunk", passportId, served({ hello: "world" })),
      ).rejects.toThrow(unseal.UnsealRecordRefused);

      await expect(
        unseal.readUnsealRecord("ipfs://bafygone", passportId, served(record, 504)),
      ).rejects.toThrow(/504/);
    });
  });

  describe("the record lookup", () => {
    const name = unseal.unsealRecordName(passportId);

    function listing(files: unknown[]): typeof fetch {
      return (async () =>
        new Response(JSON.stringify({ data: { files } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch;
    }

    it("finds the record pinned under this passport's name", async () => {
      const found = await unseal.findUnsealRecord(passportId, {
        fetchImpl: listing([{ cid: "bafyone", name, created_at: "2026-09-22T10:00:00Z" }]),
      });

      expect(found).toEqual({
        state: "found",
        record: { cid: "bafyone", uri: "ipfs://bafyone", createdAt: "2026-09-22T10:00:00Z" },
      });
    });

    it("takes the oldest when a retry left two, because the first unsealing is the one that happened", async () => {
      const found = await unseal.findUnsealRecord(passportId, {
        fetchImpl: listing([
          { cid: "bafylater", name, created_at: "2026-09-22T12:00:00Z" },
          { cid: "bafyfirst", name, created_at: "2026-09-22T10:00:00Z" },
        ]),
      });

      expect(found.state === "found" && found.record.cid).toBe("bafyfirst");
    });

    it("insists on the exact name, so another passport's record is never handed back", async () => {
      const found = await unseal.findUnsealRecord(passportId, {
        fetchImpl: listing([{ cid: "bafyother", name: `${name}.backup`, created_at: "2026-09-22T10:00:00Z" }]),
      });

      expect(found).toEqual({ state: "none" });
    });

    it("says it cannot tell for a refusal and for a body it does not know", async () => {
      const refused = await unseal.findUnsealRecord(passportId, {
        fetchImpl: (async () => new Response("no", { status: 500 })) as unknown as typeof fetch,
      });
      expect(refused.state).toBe("unavailable");
      expect(refused.state === "unavailable" && refused.reason).not.toContain("test-token-not-a-real-pinata-jwt");

      const odd = await unseal.findUnsealRecord(passportId, {
        fetchImpl: (async () =>
          new Response(JSON.stringify({ items: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })) as unknown as typeof fetch,
      });
      expect(odd.state).toBe("unavailable");

      const down = await unseal.findUnsealRecord(passportId, {
        fetchImpl: (async () => {
          throw new Error("fetch failed");
        }) as unknown as typeof fetch,
      });
      expect(down.state).toBe("unavailable");
    });
  });
});
