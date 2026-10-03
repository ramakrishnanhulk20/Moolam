// Covers opt-in B's first step: the one predicate that says a document is privately re-checkable,
// run against every case in test/fixtures/sealed-documents.json (B7), the strict sealed schema
// gaining `privateRecheck` and nothing else (B8), and the private copy a sealed /prepare or
// /generate keeps when the creator asks for a private re-check: made by the public path's own
// makeThumbnail from the signed bytes and close enough for the workflow's hash (B14), made only
// after the chain said "not registered" (B2), kept only when Pinata says it is private under its
// name (B16), left for the sweep when a prepare's document pin fails and deleted when a drawing's
// does, and refused without sealed, and the sentence each sealed document pins: the private copy
// one when a copy is kept, the old one otherwise. V12: each private copy carries its passport id in a JPEG comment, so preparing the
// same picture again keeps a copy of its own instead of being handed the first one back. From
// review pass 5: a copy the comment would push over the budget steps down a quality instead of
// being refused (intake 5), and an upload that left the process counts as landed unless Pinata
// itself refused it (sealed 3). From review pass 7 (V67): a clean-up never deletes a private copy
// Pinata answered with because it already held it, so request B's failed document pin cannot take
// away the copy request A kept for the same picture. From review pass 10 (V96): a prepare whose
// document pin fails never deletes its copy, so request A's failure cannot take away the copy
// request B was handed and registered with either, and a re-keep is noted for the sweep (V108).
// Pinata is a recording stub at the fetch layer; the chain read, the image model, the caller's
// wallets and the agent's signer are stubbed.
// Does NOT cover any route that reads the private copy back (/sealed/link, /sealed/status and
// /sealed/forget are later orders), the queue, the runner or the workflow's own copy of the
// predicate, or a real call to Pinata: scripts/pinata-private-smoke.ts is the one live check. The
// 10 second bound on each Pinata call (B15) is proven in test/pinata.test.ts.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { SignJWT, generateKeyPair } from "jose";
import { getAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyBaseLogger, FastifyInstance, LightMyRequestResponse } from "fastify";
import { decodeJpeg } from "../../workflow/moolam-verifier/decode.js";
import { perceptualHash } from "../../workflow/moolam-verifier/phash.js";
import { PACKAGE_ROOT } from "../src/env.js";
import { hamming64 } from "../src/fingerprint.js";
import {
  SEALED_CAPTURED_DESCRIPTION,
  SEALED_GENERATED_DESCRIPTION,
  SEALED_PRIVATE_CAPTURED_DESCRIPTION,
  SEALED_PRIVATE_GENERATED_DESCRIPTION,
} from "../src/metadata.js";
import {
  PRIVATE_RECHECK_THUMBNAIL_TOO_LARGE_REASON,
  THUMBNAIL_MAX_BYTES,
  THUMBNAIL_TOO_LARGE_REASON,
  makeThumbnail,
} from "../src/prepare.js";
import {
  dropPrivateCopy,
  keepPrivateCopy,
  markedPrivateCopy,
  privateCopyKeptAt,
  privateThumbnailName,
  privatelyRecheckable,
  sealedMetadata,
  sealedMetadataSchema,
} from "../src/sealed.js";
import { contentIdOf } from "../src/ipfs/pinata.js";
import { buildServer } from "../src/server.js";
import { makeImage } from "./helpers.js";

const APP_ID = vi.hoisted(() => {
  const id = "moolamtestapp0000007";
  process.env.PRIVY_APP_ID = id;
  process.env.PINATA_JWT = "test-token-not-a-real-pinata-jwt";
  process.env.PINATA_GATEWAY_URL = "https://moolam-test.mypinata.cloud/ipfs/";
  process.env.GENERATE_PER_DAY = "50";
  process.env.GENERATOR_AGENT_ID = "10249";
  process.env.PRIVY_APP_SECRET = "test-app-secret-not-a-real-one";
  process.env.PRIVY_AUTHORIZATION_KEY = "test-authorization-key-not-a-real-one";
  return id;
});

const stubs = vi.hoisted(() => ({
  passportExists: vi.fn(),
  createImage: vi.fn(),
  sign: vi.fn(),
  wallet: vi.fn(),
  embeddedWallets: vi.fn(),
}));

vi.mock("../src/edit/registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/edit/registry.js")>()),
  passportExists: stubs.passportExists,
}));

vi.mock("../src/auth/wallet.js", () => ({ embeddedWallets: stubs.embeddedWallets }));

/** While on, every sealed prepare is handed the first one's result, as the unsigned path gives one picture one id. */
const sealedRepeat = vi.hoisted(() => ({ on: false, first: undefined as unknown }));

vi.mock("../src/prepare.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/prepare.js")>();
  return {
    ...real,
    prepareSealed: async (...args: Parameters<typeof real.prepareSealed>) => {
      if (!sealedRepeat.on) return await real.prepareSealed(...args);
      sealedRepeat.first ??= await real.prepareSealed(...args);
      return sealedRepeat.first as Awaited<ReturnType<typeof real.prepareSealed>>;
    },
  };
});

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
const PRIVATE_FILES_URL = "https://api.pinata.cloud/v3/files/private";
const PRIVATE_CID = "bafkreiprivatecopy000000000000000000000000000000000000000";
const PRIVATE_ID = "0199a3c2-5d7e-7f10-9a1b-2c3d4e5f6a7b";
const CREATOR = getAddress("0x85a88ca81ff5f681d96ab86fa60ccb8452a139a6" as Hex);
const PROMPT = "A lighthouse in a monsoon storm, painted in thick oils";

/** One call the recording Pinata saw, in order. */
interface Call {
  kind: "public" | "private" | "delete";
  name?: string;
  type?: string;
  bytes?: Buffer;
  keyvalues?: Record<string, string>;
  url: string;
}

/** How the recording Pinata answers the next calls. Reset after every test. */
const pinata = {
  privateAnswer: "private" as "private" | "duplicate-public" | "refused" | "by-content" | "server-error" | "unreadable" | "timeout",
  failJson: false,
  failDelete: false,
  /** When set, the next document pin waits for it and is then refused. */
  holdDocument: undefined as Promise<void> | undefined,
};
const calls: Call[] = [];
/** The private files the "by-content" answer has seen, keyed by content, as Pinata de-duplicates. */
const byContent = new Map<string, { id: string; name: string }>();
let signing: CryptoKey;
let verifying: CryptoKey;
let app: FastifyInstance;
let IMAGE: Buffer;
let NOISE: Buffer;

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

async function prepare(subject: string, fields: Record<string, string>, file?: Buffer): Promise<LightMyRequestResponse> {
  const boundary = "----moolamprivate";
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="upload.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
    ),
    file ?? IMAGE,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return await app.inject({
    method: "POST",
    url: "/prepare",
    payload: Buffer.concat(chunks),
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      authorization: `Bearer ${await token(subject)}`,
    },
    remoteAddress: "198.51.100.70",
  });
}

async function generate(subject: string, extra: Record<string, unknown>): Promise<LightMyRequestResponse> {
  return await app.inject({
    method: "POST",
    url: "/generate",
    payload: {
      prompt: PROMPT,
      title: "A private lighthouse",
      creator: CREATOR,
      deadline: Math.floor(Date.now() / 1000) + 1800,
      ...extra,
    },
    headers: { authorization: `Bearer ${await token(subject)}` },
    remoteAddress: "198.51.100.71",
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function recordingPinata(): void {
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === UPLOAD_URL) {
      const form = init?.body as FormData;
      const file = form.get("file") as File;
      const bytes = Buffer.from(await file.arrayBuffer());
      const name = String(form.get("name"));
      if (form.get("network") === "private") {
        calls.push({
          kind: "private",
          name,
          type: file.type,
          bytes,
          keyvalues: JSON.parse(String(form.get("keyvalues"))) as Record<string, string>,
          url,
        });
        if (pinata.privateAnswer === "refused") {
          return new Response("private files need another plan", { status: 403 });
        }
        if (pinata.privateAnswer === "server-error") {
          return new Response("upstream fell over", { status: 502 });
        }
        if (pinata.privateAnswer === "unreadable") {
          return new Response("<html>stored</html>", { status: 200 });
        }
        if (pinata.privateAnswer === "timeout") {
          throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
        }
        if (pinata.privateAnswer === "by-content") {
          // Pinata answers bytes it already holds with the file it already holds, under the old name.
          const cid = contentIdOf(bytes);
          const first = byContent.get(cid);
          if (first !== undefined) {
            return json({ data: { id: first.id, name: first.name, cid, network: "private", is_duplicate: true } });
          }
          const id = `0199a3c2-5d7e-7f10-9a1b-${byContent.size.toString(16).padStart(12, "0")}`;
          byContent.set(cid, { id, name });
          return json({ data: { id, name, cid, network: "private", is_duplicate: false } });
        }
        return pinata.privateAnswer === "duplicate-public"
          ? json({ data: { id: PRIVATE_ID, name: "harbour-thumb.jpg", cid: "bafkreipublic", network: "public", is_duplicate: true } })
          : json({ data: { id: PRIVATE_ID, name, cid: PRIVATE_CID, network: "private", is_duplicate: false } });
      }
      calls.push({ kind: "public", name, type: file.type, bytes, url });
      const held = file.type === "application/json" ? pinata.holdDocument : undefined;
      if (held !== undefined) {
        pinata.holdDocument = undefined;
        await held;
        return new Response("refused", { status: 403 });
      }
      if (pinata.failJson && file.type === "application/json") {
        return new Response("refused", { status: 403 });
      }
      return json({ data: { cid: contentIdOf(bytes), size: bytes.length, network: "public" } });
    }
    if (url.startsWith(PRIVATE_FILES_URL) && init?.method === "DELETE") {
      calls.push({ kind: "delete", url });
      return pinata.failDelete ? new Response("down", { status: 500 }) : json({ data: null });
    }
    return await realFetch(input, init);
  });
}

function since(mark: number): Call[] {
  return calls.slice(mark);
}

function documentOf(made: Call[]): Record<string, unknown> {
  const pinned = made.find((call) => call.kind === "public" && call.type === "application/json") as Call;
  return JSON.parse((pinned.bytes as Buffer).toString("utf8")) as Record<string, unknown>;
}

/** A logger that keeps every line, for the unit test of the step that must name a file id. */
function keepingLogger(): { log: FastifyBaseLogger; lines: Array<{ level: string; fields: unknown; message: unknown }> } {
  const lines: Array<{ level: string; fields: unknown; message: unknown }> = [];
  const at =
    (level: string) =>
    (fields: unknown, message?: unknown): void => {
      lines.push({ level, fields, message });
    };
  const log = {
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    debug: at("debug"),
    trace: at("trace"),
    fatal: at("fatal"),
    child: () => log,
    level: "info",
    silent: () => undefined,
  } as unknown as FastifyBaseLogger;
  return { log, lines };
}

interface FixtureCase {
  name: string;
  recheckable: boolean;
  document: unknown;
}

const fixtures = JSON.parse(
  readFileSync(path.join(PACKAGE_ROOT, "test", "fixtures", "sealed-documents.json"), "utf8"),
) as { cases: FixtureCase[] };

const PASSPORT = `0x${"ab".repeat(32)}` as Hex;

// The plain sealed sentences as they were pinned before the private re-check existed, copied here
// so a change to the constants cannot quietly change what every plain sealed passport says.
const PLAIN_SEALED_CAPTURED =
  "A picture registered with Moolam from a file its creator uploaded and chose to keep sealed, so the picture itself was never published and Moolam kept no copy of it. The passport id is the sha256 of the signed file, so this record commits to the exact bytes without showing them. The creator signed this fingerprint with a passkey before the registry would write the record.";
const PLAIN_SEALED_GENERATED =
  "An image made by the Moolam demo generator agent and registered sealed, so the picture itself was never published and Moolam kept no copy of it. The passport id is the sha256 of the signed file, so this record commits to the exact bytes without showing them. The agent signed this fingerprint with the wallet that owns its ERC-8004 identity, and the creator signed it with a passkey, before the registry would write the record.";

function aSealedInput(privateRecheck?: boolean): Parameters<typeof sealedMetadata>[0] {
  return {
    title: "Harbour at dusk",
    description: "A picture registered with Moolam and kept sealed.",
    passportId: PASSPORT,
    fingerprint: {
      sha256: PASSPORT,
      phash: 7840506850305415717n,
      blockhash: `0x${"11".repeat(32)}` as Hex,
      width: 640,
      height: 480,
      format: "jpeg",
    },
    privateRecheck,
  };
}

describe("B7: the one predicate for privately re-checkable", () => {
  it("covers every case the rule needs in the shared fixture set", () => {
    const names = fixtures.cases.map((one) => one.name);
    for (const required of [
      "public",
      "plain sealed",
      "sealed plus privateRecheck",
      "privateRecheck without sealed",
      "sealed plus privateRecheck plus an image key",
      "privateRecheck as the string true",
      "a non-object: null",
    ]) {
      expect(names).toContain(required);
    }
    expect(fixtures.cases.filter((one) => one.recheckable).map((one) => one.name)).toEqual([
      "sealed plus privateRecheck",
    ]);
  });

  for (const one of fixtures.cases) {
    it(`says ${String(one.recheckable)} for ${one.name}`, () => {
      expect(privatelyRecheckable(one.document)).toBe(one.recheckable);
    });
  }

  it("agrees with the schema: the one recheckable fixture is a document this service would pin", () => {
    const recheckable = fixtures.cases.find((one) => one.recheckable) as FixtureCase;
    expect(sealedMetadataSchema.safeParse(recheckable.document).success).toBe(true);
    expect(privatelyRecheckable(sealedMetadata(aSealedInput(true)))).toBe(true);
    expect(privatelyRecheckable(sealedMetadata(aSealedInput()))).toBe(false);
  });
});

describe("B8: the public document stays strict", () => {
  it("accepts privateRecheck only as the boolean true, and writes it only when asked", () => {
    const plain = sealedMetadata(aSealedInput());
    const opted = sealedMetadata(aSealedInput(true));

    expect(JSON.parse(JSON.stringify(plain)).privateRecheck).toBeUndefined();
    expect(opted.privateRecheck).toBe(true);
    expect(JSON.parse(JSON.stringify(sealedMetadata(aSealedInput(false)))).privateRecheck).toBeUndefined();

    for (const value of ["true", false, 1, null]) {
      expect(sealedMetadataSchema.safeParse({ ...opted, privateRecheck: value }).success, String(value)).toBe(false);
    }
  });

  it("still refuses any key that would carry the private file: its id, content id, name or a link", () => {
    const opted = sealedMetadata(aSealedInput(true));
    for (const leak of ["privateFileId", "privateCid", "privateName", "privateLink", "thumbnail", "image"]) {
      const parsed = sealedMetadataSchema.safeParse({ ...opted, [leak]: "bafkreileaked" });
      expect(parsed.success, leak).toBe(false);
      expect(JSON.stringify(parsed.error?.issues), leak).toContain("unrecognized_keys");
    }
  });
});

describe("a sealed registration with a private re-check", () => {
  beforeAll(async () => {
    IMAGE = await makeImage(23);
    // Pure noise at full quality: the one kind of picture a 512 pixel JPEG cannot squeeze under 60 KB.
    const side = 512;
    const raw = Buffer.alloc(side * side * 3);
    let state = 777;
    for (let i = 0; i < raw.length; i += 1) {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      raw[i] = (state >> 16) & 0xff;
    }
    NOISE = await sharp(raw, { raw: { width: side, height: side, channels: 3 } }).jpeg({ quality: 100 }).toBuffer();

    stubs.passportExists.mockResolvedValue(false);
    const pair = await generateKeyPair("ES256", { extractable: true });
    signing = pair.privateKey;
    verifying = pair.publicKey;
    const agent = privateKeyToAccount(generatePrivateKey());
    stubs.wallet.mockImplementation(async () => ({ id: "moolam-test-generator", address: agent.address }));
    stubs.sign.mockImplementation(async () => `0x${"ab".repeat(65)}`);
    stubs.embeddedWallets.mockImplementation(async () => [CREATOR]);
    stubs.createImage.mockImplementation(async (prompt: string) => ({
      bytes: await makeImage(prompt.length % 40),
      model: "gpt-image-1-mini",
      promptUsed: prompt,
    }));
    recordingPinata();

    app = await buildServer({
      source: { load: async () => [] },
      logger: false,
      prepare: { keys: verifying },
      generate: { keys: verifying },
    });
    await app.ready();
  }, 60_000);

  afterEach(() => {
    pinata.privateAnswer = "private";
    byContent.clear();
    pinata.failJson = false;
    pinata.failDelete = false;
    stubs.passportExists.mockReset();
    stubs.passportExists.mockResolvedValue(false);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await app.close();
  });

  // B8, and the order: private copy first, then the document, which says privateRecheck and
  // names nothing about the private file.
  it("B8: on /prepare keeps one private thumbnail, then pins a document that flags it and names nothing of it", async () => {
    const mark = calls.length;
    const response = await prepare("did:privy:private-happy", {
      title: "Harbour kept private",
      kind: "human",
      sealed: "true",
      privateRecheck: "true",
    });

    expect(response.statusCode).toBe(200);
    const answer = response.json();
    expect(answer.privateRecheck).toBe(true);
    expect(answer.sealed).toBe(true);
    const made = since(mark);
    expect(made.map((call) => `${call.kind}:${call.type}`)).toEqual(["private:image/jpeg", "public:application/json"]);

    const id = (answer.passport.exactHash as string).toLowerCase();
    const upload = made[0] as Call;
    expect(upload.name).toBe(`sealed-thumb-${id}.jpg`);
    expect(upload.keyvalues).toEqual({ passportId: id });

    const document = documentOf(made);
    expect(document.privateRecheck).toBe(true);
    expect(document.image).toBeUndefined();
    expect(document.thumbnail).toBeUndefined();
    expect(sealedMetadataSchema.safeParse(document).success).toBe(true);
    expect(privatelyRecheckable(document)).toBe(true);
    const text = JSON.stringify(document);
    for (const secret of [PRIVATE_ID, PRIVATE_CID, "sealed-thumb", "mypinata", "ipfs://"]) {
      expect(text, secret).not.toContain(secret);
    }
    expect(response.body).not.toContain(PRIVATE_ID);
    expect(response.body).not.toContain(PRIVATE_CID);
  }, 60_000);

  it("changes nothing for a plain sealed or a public prepare: no private upload, no flag", async () => {
    const sealedMark = calls.length;
    const sealed = await prepare("did:privy:private-plain-sealed", { title: "Plain sealed", kind: "human", sealed: "true" });
    expect(sealed.statusCode).toBe(200);
    expect(sealed.json().privateRecheck).toBeUndefined();
    expect(since(sealedMark).map((call) => call.kind)).toEqual(["public"]);
    expect(documentOf(since(sealedMark)).privateRecheck).toBeUndefined();

    const publicMark = calls.length;
    const open = await prepare("did:privy:private-public", { title: "Plain public", kind: "human", privateRecheck: "false" });
    expect(open.statusCode).toBe(200);
    expect(open.json().privateRecheck).toBeUndefined();
    expect(since(publicMark).every((call) => call.kind === "public")).toBe(true);
  }, 60_000);

  // B14: the same thumbnail the public path would make, from the signed bytes.
  it("B14: uploads exactly makeThumbnail of the signed file, which the workflow hashes within 10 of the chain's", async () => {
    const mark = calls.length;
    const response = await prepare("did:privy:private-b14", {
      title: "Same thumbnail",
      kind: "human",
      sealed: "true",
      privateRecheck: "true",
    });

    expect(response.statusCode).toBe(200);
    const answer = response.json();
    const signed = Buffer.from(answer.signedFile.bytes as string, "base64");
    expect(`0x${createHash("sha256").update(signed).digest("hex")}`).toBe(answer.passport.exactHash);

    const uploaded = (since(mark)[0] as Call).bytes as Buffer;
    const made = await makeThumbnail(signed);
    expect(uploaded.equals(markedPrivateCopy(made, answer.passport.exactHash as Hex))).toBe(true);
    expect(uploaded.toString("latin1")).toContain(`moolam-private-copy ${(answer.passport.exactHash as string).toLowerCase()}`);
    // The comment is the only difference: the pixels are the public path's own thumbnail.
    expect((await sharp(uploaded).raw().toBuffer()).equals(await sharp(made).raw().toBuffer())).toBe(true);
    expect(uploaded.length).toBeLessThanOrEqual(THUMBNAIL_MAX_BYTES);
    const size = await sharp(uploaded).metadata();
    expect(Math.max(size.width ?? 0, size.height ?? 0)).toBeLessThanOrEqual(512);

    const decoded = decodeJpeg(new Uint8Array(uploaded));
    const recomputed = perceptualHash(decoded.pixels, decoded.width, decoded.height, decoded.channels);
    expect(hamming64(BigInt(answer.passport.phash as string), recomputed)).toBeLessThanOrEqual(10);
  }, 60_000);

  it("B14: refuses a picture whose thumbnail is over the budget with 422 and the private re-check words, uploading nothing", async () => {
    const mark = calls.length;
    const refused = await prepare(
      "did:privy:private-noise",
      { title: "Static", kind: "human", sealed: "true", privateRecheck: "true" },
      NOISE,
    );

    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toEqual({
      error: "thumbnail-too-large",
      limit: THUMBNAIL_MAX_BYTES,
      reason: PRIVATE_RECHECK_THUMBNAIL_TOO_LARGE_REASON,
    });
    expect(refused.json().reason).toMatch(/private re-check could never open it/);
    expect(refused.json().reason).not.toMatch(/still works/);
    expect(since(mark)).toHaveLength(0);

    // Sealed without the re-check it is refused too, since an unseal could never publish it
    // (review pass 8, intake 5, V72), and nothing is pinned either way. It hears the plain
    // sentence, never the private re-check one, which would tell it plain sealing still works.
    const plain = await prepare("did:privy:private-noise-plain", { title: "Static", kind: "human", sealed: "true" }, NOISE);
    expect(plain.statusCode).toBe(422);
    expect(plain.json()).toEqual({
      error: "thumbnail-too-large",
      limit: THUMBNAIL_MAX_BYTES,
      reason: THUMBNAIL_TOO_LARGE_REASON,
    });
    expect(since(mark)).toHaveLength(0);
  }, 120_000);

  it("answers 400 private-recheck-needs-sealed without sealed, and pins nothing", async () => {
    const mark = calls.length;
    const unsealed: Array<Record<string, string>> = [
      { title: "Not sealed", kind: "human", privateRecheck: "true" },
      { title: "Not sealed", kind: "human", sealed: "false", privateRecheck: "true" },
    ];
    for (const fields of unsealed) {
      const response = await prepare("did:privy:private-unsealed", fields);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "private-recheck-needs-sealed" });
    }

    const typo = await prepare("did:privy:private-typo", { title: "Typo", kind: "human", sealed: "true", privateRecheck: "yes" });
    expect(typo.statusCode).toBe(400);
    expect(typo.json().error).toContain("privateRecheck");
    expect(since(mark)).toHaveLength(0);
  }, 60_000);

  // B2: the only writer of a sealed-thumb name is a prepare the chain said was not registered.
  it("B2: a second prepare of the same bytes uploads nothing once the chain holds the passport", async () => {
    const first = await prepare("did:privy:private-b2", {
      title: "Registered once",
      kind: "human",
      sealed: "true",
      privateRecheck: "true",
    });
    expect(first.statusCode).toBe(200);
    expect(stubs.passportExists).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      first.json().passport.exactHash,
    );
    // The signer stamps every manifest with its own instance id, so the signed bytes, and the id
    // the chain is asked about, differ from one prepare to the next. The stub answers "registered"
    // for whatever id the second prepare asks about, which is the chain holding those bytes.
    stubs.passportExists.mockResolvedValue(true);

    const mark = calls.length;
    const second = await prepare("did:privy:private-b2-again", {
      title: "Registered once",
      kind: "human",
      sealed: "true",
      privateRecheck: "true",
    });

    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("already-registered");
    expect(stubs.passportExists).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), second.json().passportId);
    expect(since(mark)).toHaveLength(0);
  }, 60_000);

  it("B2: refuses a private re-check with 503 chain-unreachable when the duplicate check fails, and keeps plain sealed as it was", async () => {
    stubs.passportExists.mockRejectedValue(new Error("the RPC timed out"));

    const mark = calls.length;
    const refused = await prepare("did:privy:private-no-chain", {
      title: "No chain",
      kind: "human",
      sealed: "true",
      privateRecheck: "true",
    });
    expect(refused.statusCode).toBe(503);
    expect(refused.json()).toEqual({ error: "chain-unreachable" });
    expect(since(mark)).toHaveLength(0);

    const plain = await prepare("did:privy:private-no-chain-plain", { title: "No chain", kind: "human", sealed: "true" });
    expect(plain.statusCode).toBe(200);
  }, 60_000);

  // V12: the same picture prepared twice makes two passports, and each keeps a copy of its own.
  it("V12: keeps a copy of its own when the same picture is prepared again with a private re-check", async () => {
    pinata.privateAnswer = "by-content";
    const fields = { title: "Harbour, twice", kind: "human", sealed: "true", privateRecheck: "true" };

    const mark = calls.length;
    const first = await prepare("did:privy:private-v12", fields);
    const second = await prepare("did:privy:private-v12", fields);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode, second.body).toBe(200);
    const ids = [first, second].map((one) => (one.json().passport.exactHash as string).toLowerCase());
    expect(ids[0]).not.toBe(ids[1]);
    const uploads = since(mark).filter((call) => call.kind === "private");
    expect(uploads.map((call) => call.name)).toEqual(ids.map((id) => `sealed-thumb-${id}.jpg`));
    expect(((uploads[0] as Call).bytes as Buffer).equals((uploads[1] as Call).bytes as Buffer)).toBe(false);
    expect(byContent.size).toBe(2);
  }, 60_000);

  // B16: the private copy is private or it does not exist.
  it("B16: refuses the whole prepare with 409 when Pinata hands back the public duplicate, pinning no document and deleting nothing", async () => {
    pinata.privateAnswer = "duplicate-public";
    const mark = calls.length;
    const response = await prepare("did:privy:private-b16", {
      title: "Already public somewhere",
      kind: "human",
      sealed: "true",
      privateRecheck: "true",
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "private-copy-not-private" });
    expect(since(mark).map((call) => call.kind)).toEqual(["private"]);
  }, 60_000);

  it("B16: logs the file id Pinata gave back so an operator can look", async () => {
    pinata.privateAnswer = "duplicate-public";
    const { log, lines } = keepingLogger();
    const passportId = `0x${"CD".repeat(32)}` as Hex;

    const thumbnail = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#204060" } }).jpeg().toBuffer();
    const outcome = await keepPrivateCopy(thumbnail, passportId, log);

    expect(outcome).toEqual({ refused: { status: 409, body: { error: "private-copy-not-private" } }, landed: true });
    const line = lines.find((one) => one.level === "error");
    expect(line?.fields).toMatchObject({ fileId: PRIVATE_ID, passportId: passportId.toLowerCase() });
    expect(privateThumbnailName(passportId)).toBe(`sealed-thumb-0x${"cd".repeat(32)}.jpg`);
  });

  it("V67: request B, answered with the copy request A kept, fails its document pin and leaves A's copy alone", async () => {
    pinata.privateAnswer = "by-content";
    const thumbnail = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#406020" } }).jpeg().toBuffer();
    const { log, lines } = keepingLogger();
    const mark = calls.length;
    const startedAt = Date.now();

    const kept = await keepPrivateCopy(thumbnail, PASSPORT, log);
    const keptFirst = privateCopyKeptAt(PASSPORT) as number;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const again = await keepPrivateCopy(thumbnail, PASSPORT, log);
    // Pass 10 (V108): the re-keep of a file Pinata already held is noted, so the sweep ages the copy
    // by it and not by the first upload.
    expect(keptFirst).toBeGreaterThanOrEqual(startedAt);
    expect(privateCopyKeptAt(PASSPORT)).toBeGreaterThan(keptFirst);
    if (!("kept" in kept) || !("kept" in again)) {
      throw new Error("both requests should have been answered with a private file");
    }
    expect(again.kept.id).toBe(kept.kept.id);
    expect(kept.kept.heldBefore).toBe(false);
    expect(again.kept.heldBefore).toBe(true);

    await dropPrivateCopy(again.kept, log);
    expect(since(mark).filter((call) => call.kind === "delete")).toEqual([]);
    expect(lines.some((line) => line.level === "warn" && JSON.stringify(line.fields).includes(kept.kept.id))).toBe(true);

    await dropPrivateCopy(kept.kept, log);
    expect(since(mark).filter((call) => call.kind === "delete").map((call) => call.url)).toEqual([
      `${PRIVATE_FILES_URL}/${kept.kept.id}`,
    ]);
  });

  // Review pass 10, intake #5 (V96), the mirror of V67: request A made the file, request B of the
  // same bytes was answered with it and pinned its document, then A's document pin failed.
  it("V96: a failed document pin leaves the private copy that a second prepare of the same bytes relies on", async () => {
    pinata.privateAnswer = "by-content";
    sealedRepeat.on = true;
    let release = (): void => undefined;
    pinata.holdDocument = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fields = { title: "Harbour, mirrored", kind: "human", sealed: "true", privateRecheck: "true" };
    const mark = calls.length;
    try {
      const first = prepare("did:privy:private-v96", fields);
      for (let i = 0; i < 400 && !since(mark).some((call) => call.kind === "public"); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const second = await prepare("did:privy:private-v96", fields);
      expect(second.statusCode, second.body).toBe(200);
      release();
      const failed = await first;

      expect(failed.statusCode).toBe(502);
      expect(failed.json()).toEqual({ error: "pin-failed" });
      const uploads = since(mark).filter((call) => call.kind === "private");
      expect(uploads).toHaveLength(2);
      expect((uploads[0] as Call).name).toBe((uploads[1] as Call).name);
      expect(byContent.size).toBe(1);
      expect(since(mark).filter((call) => call.kind === "delete")).toEqual([]);
    } finally {
      release();
      pinata.holdDocument = undefined;
      sealedRepeat.on = false;
      sealedRepeat.first = undefined;
    }
  }, 120_000);

  it("V12: refuses with 422 and uploads nothing when the passport's comment would push the copy past the budget", async () => {
    const { log } = keepingLogger();
    const nearlyFull = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(THUMBNAIL_MAX_BYTES - 12, 0x20)]);
    const mark = calls.length;

    const outcome = await keepPrivateCopy(nearlyFull, PASSPORT, log);

    expect(outcome).toEqual({
      refused: {
        status: 422,
        body: { error: "thumbnail-too-large", limit: THUMBNAIL_MAX_BYTES, reason: PRIVATE_RECHECK_THUMBNAIL_TOO_LARGE_REASON },
      },
      landed: false,
    });
    expect(since(mark)).toHaveLength(0);
  });

  it("sealed 3: counts a private upload as landed once it left the process, and as not landed only on Pinata's refusal", async () => {
    const thumbnail = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#204060" } }).jpeg().toBuffer();
    const outcomes: Record<string, boolean> = {};
    for (const answer of ["server-error", "unreadable", "timeout", "refused"] as const) {
      pinata.privateAnswer = answer;
      const { log } = keepingLogger();
      const outcome = await keepPrivateCopy(thumbnail, PASSPORT, log);
      expect(outcome, answer).toMatchObject({ refused: { status: 502, body: { error: "pin-failed" } } });
      outcomes[answer] = (outcome as { landed: boolean }).landed;
    }

    expect(outcomes).toEqual({ "server-error": true, unreadable: true, timeout: true, refused: false });
  });

  it("intake 5: keeps a private copy the passport comment would have pushed over the budget, one quality step down", async () => {
    // A picture whose first fitting thumbnail sits within the comment's 90 bytes of the budget,
    // found by growing a band of noise under structured shapes one pixel at a time.
    const width = 512;
    const height = 512;
    const shapes = await sharp(await makeImage(29)).resize(width, height, { fit: "fill" }).removeAlpha().raw().toBuffer();
    const pictureWith = async (noisy: number): Promise<Buffer> => {
      const raw = Buffer.from(shapes);
      let state = 31337;
      const start = raw.length - noisy * 3;
      for (let i = start; i < raw.length; i += 1) {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        raw[i] = (state >> 16) & 0xff;
      }
      return await sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
    };
    const sizeAtStart = async (noisy: number): Promise<number> =>
      (await sharp(await pictureWith(noisy)).jpeg({ quality: 85, progressive: false }).toBuffer()).length;

    let low = 0;
    let high = width * height;
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if ((await sizeAtStart(middle)) <= THUMBNAIL_MAX_BYTES) {
        low = middle;
      } else {
        high = middle;
      }
    }
    const upload = await pictureWith(low);
    const plain = await makeThumbnail(upload);
    expect(plain.length).toBeLessThanOrEqual(THUMBNAIL_MAX_BYTES);
    expect(plain.length).toBeGreaterThan(THUMBNAIL_MAX_BYTES - 90);

    const mark = calls.length;
    const response = await prepare(
      "did:privy:private-near-cap",
      { title: "Right at the edge", kind: "human", sealed: "true", privateRecheck: "true" },
      upload,
    );

    expect(response.statusCode).toBe(200);
    expect(response.json().privateRecheck).toBe(true);
    const kept = since(mark).find((call) => call.kind === "private") as Call;
    expect((kept.bytes as Buffer).length).toBeLessThanOrEqual(THUMBNAIL_MAX_BYTES);
    const print = decodeJpeg(new Uint8Array(kept.bytes as Buffer));
    expect(print.width).toBe(width);
  }, 120_000);

  it("answers 502 pin-failed when Pinata refuses the private upload, with no document pinned", async () => {
    pinata.privateAnswer = "refused";
    const mark = calls.length;
    const response = await prepare("did:privy:private-refused", {
      title: "Plan says no",
      kind: "human",
      sealed: "true",
      privateRecheck: "true",
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "pin-failed" });
    expect(since(mark).map((call) => call.kind)).toEqual(["private"]);
  }, 60_000);

  it("V96: leaves the private copy for the sweep when the document pin fails after it, and answers 502", async () => {
    pinata.failJson = true;
    const mark = calls.length;
    const response = await prepare("did:privy:private-drop", {
      title: "Document refused",
      kind: "human",
      sealed: "true",
      privateRecheck: "true",
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "pin-failed" });
    expect(since(mark).map((call) => call.kind)).toEqual(["private", "public"]);
  }, 120_000);

  it("takes the studio's five text fields and refuses a sixth with 400 too-many-fields, pinning nothing", async () => {
    const five = {
      title: "Every field the studio sends",
      kind: "human",
      training: JSON.stringify({ aiGenerativeTraining: "notAllowed" }),
      sealed: "true",
      privateRecheck: "true",
    };
    const accepted = await prepare("did:privy:private-five-fields", five);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().privateRecheck).toBe(true);
    expect(accepted.json().training).toEqual({ aiGenerativeTraining: "notAllowed", standard: "cawg.training-mining/1.1" });

    const mark = calls.length;
    const six = await prepare("did:privy:private-six-fields", { ...five, image: "ipfs://bafysmuggled" });
    expect(six.statusCode).toBe(400);
    expect(six.json()).toEqual({ error: "too-many-fields" });
    expect(since(mark)).toHaveLength(0);
  }, 60_000);

  it("B8 and B14 on /generate: keeps the same private thumbnail and flags the document, naming nothing of it", async () => {
    const mark = calls.length;
    const response = await generate("did:privy:private-draw", { sealed: true, privateRecheck: true });

    expect(response.statusCode).toBe(200);
    const answer = response.json();
    expect(answer.sealed).toBe(true);
    expect(answer.privateRecheck).toBe(true);
    const made = since(mark);
    expect(made.map((call) => `${call.kind}:${call.type}`)).toEqual(["private:image/jpeg", "public:application/json"]);

    const id = (answer.passport.exactHash as string).toLowerCase();
    expect((made[0] as Call).name).toBe(`sealed-thumb-${id}.jpg`);
    expect((made[0] as Call).keyvalues).toEqual({ passportId: id });
    const signed = Buffer.from(answer.signedFile.bytes as string, "base64");
    expect(((made[0] as Call).bytes as Buffer).equals(markedPrivateCopy(await makeThumbnail(signed), id as Hex))).toBe(true);

    const document = documentOf(made);
    expect(privatelyRecheckable(document)).toBe(true);
    expect(sealedMetadataSchema.safeParse(document).success).toBe(true);
    for (const secret of [PRIVATE_ID, PRIVATE_CID, "sealed-thumb"]) {
      expect(JSON.stringify(document), secret).not.toContain(secret);
    }
  }, 60_000);

  it("answers 400 private-recheck-needs-sealed on /generate before anything is drawn or pinned", async () => {
    const mark = calls.length;
    stubs.createImage.mockClear();

    for (const body of [{ privateRecheck: true }, { sealed: false, privateRecheck: true }]) {
      const response = await generate("did:privy:private-draw-unsealed", body);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "private-recheck-needs-sealed" });
    }
    expect(stubs.createImage).not.toHaveBeenCalled();
    expect(since(mark)).toHaveLength(0);
  });

  it("B2 on /generate: uploads nothing when the chain holds the passport or cannot be reached", async () => {
    const mark = calls.length;
    stubs.passportExists.mockResolvedValue(true);
    const registered = await generate("did:privy:private-draw-b2", { sealed: true, privateRecheck: true });
    expect(registered.statusCode).toBe(409);
    expect(registered.json().error).toBe("already-registered");

    stubs.passportExists.mockRejectedValue(new Error("the RPC timed out"));
    const unreachable = await generate("did:privy:private-draw-b2", { sealed: true, privateRecheck: true });
    expect(unreachable.statusCode).toBe(503);
    expect(unreachable.json()).toEqual({ error: "chain-unreachable" });
    expect(since(mark)).toHaveLength(0);

    // A plain sealed drawing never asked the chain before this order, and still does not.
    const plain = await generate("did:privy:private-draw-b2-plain", { sealed: true });
    expect(plain.statusCode).toBe(200);
  }, 120_000);

  it("B16 on /generate: refuses with 409 and pins no document when the copy comes back public", async () => {
    pinata.privateAnswer = "duplicate-public";
    const mark = calls.length;
    const response = await generate("did:privy:private-draw-b16", { sealed: true, privateRecheck: true });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "private-copy-not-private" });
    expect(since(mark).map((call) => call.kind)).toEqual(["private"]);
  }, 60_000);

  it("deletes the private copy on /generate when the document pin fails after it", async () => {
    pinata.failJson = true;
    const mark = calls.length;
    const response = await generate("did:privy:private-draw-drop", { sealed: true, privateRecheck: true });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "pin-failed" });
    expect(since(mark).map((call) => call.kind)).toEqual(["private", "public", "delete"]);
  }, 60_000);

  it("pins the private copy sentence for a private re-check prepare and the old sentence, byte for byte, for a plain sealed one", async () => {
    const privateMark = calls.length;
    const kept = await prepare("did:privy:private-words", {
      title: "Words that are true",
      kind: "human",
      sealed: "true",
      privateRecheck: "true",
    });
    expect(kept.statusCode).toBe(200);
    const said = documentOf(since(privateMark)).description as string;
    expect(said).toBe(SEALED_PRIVATE_CAPTURED_DESCRIPTION);
    expect(said).not.toContain("kept no copy");
    expect(said).toContain("512 pixels");
    expect(said).toContain("holder can delete it");

    const plainMark = calls.length;
    const plain = await prepare("did:privy:private-words-plain", { title: "Words unchanged", kind: "human", sealed: "true" });
    expect(plain.statusCode).toBe(200);
    expect(SEALED_CAPTURED_DESCRIPTION).toBe(PLAIN_SEALED_CAPTURED);
    expect(documentOf(since(plainMark)).description).toBe(PLAIN_SEALED_CAPTURED);
  }, 60_000);

  it("pins the private copy sentence for a private re-check drawing and the old sentence, byte for byte, for a plain sealed one", async () => {
    const privateMark = calls.length;
    const kept = await generate("did:privy:private-draw-words", { sealed: true, privateRecheck: true });
    expect(kept.statusCode).toBe(200);
    const said = documentOf(since(privateMark)).description as string;
    expect(said).toBe(SEALED_PRIVATE_GENERATED_DESCRIPTION);
    expect(said).not.toContain("kept no copy");
    expect(said).toContain("512 pixels");
    expect(said).toContain("holder can delete it");

    const plainMark = calls.length;
    const plain = await generate("did:privy:private-draw-words-plain", { sealed: true });
    expect(plain.statusCode).toBe(200);
    expect(SEALED_GENERATED_DESCRIPTION).toBe(PLAIN_SEALED_GENERATED);
    expect(documentOf(since(plainMark)).description).toBe(PLAIN_SEALED_GENERATED);
  }, 60_000);

  it("B14 on /generate: refuses a drawing whose thumbnail is over the budget with 422 and uploads nothing", async () => {
    stubs.createImage.mockImplementationOnce(async (prompt: string) => ({
      bytes: NOISE,
      model: "gpt-image-1-mini",
      promptUsed: prompt,
    }));
    const mark = calls.length;
    const response = await generate("did:privy:private-draw-noise", { sealed: true, privateRecheck: true });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({
      error: "thumbnail-too-large",
      limit: THUMBNAIL_MAX_BYTES,
      reason: PRIVATE_RECHECK_THUMBNAIL_TOO_LARGE_REASON,
    });
    expect(since(mark)).toHaveLength(0);
  }, 60_000);
});
