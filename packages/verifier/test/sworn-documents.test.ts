// Covers what a passport's document says in its registrant's own voice (WO-275b, L21, L25), and the
// platform kit's look-alike warning end to end. Every document the studio and the co-sign page pin
// carries the sworn line and its version; a platform-mode document carries the platform's statement
// byte for byte instead, or no statement when the kit sent none, never both; `seenEarlier` names the
// earlier passport only when the prepare answer said "found", by the one lower-case id pattern; a
// sealed document has no room for web pages. POST /prepare (public and sealed) and POST
// /platform/prepare (platform and co-sign) run end to end with Pinata answered at the fetch layer,
// the chain reads, the duplicate check and the signer's key load stubbed, and an index seeded with
// an earlier passport of the very picture sent.
// Does NOT cover /generate and /edit end to end (their documents take the same sworn statements
// through passportMetadata and sealedMetadata, which this file checks), how the site words a
// passport with no statement (WO-277), or a real pin, Privy or Monad read.

import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SignJWT, generateKeyPair } from "jose";
import { type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { idFrom, makeImage } from "./helpers.js";

const APP_ID = vi.hoisted(() => {
  const id = "moolamtestapp0000032";
  process.env.PRIVY_APP_ID = id;
  process.env.PRIVY_APP_SECRET = "test-secret-not-a-real-privy-secret";
  process.env.PINATA_JWT = "test-token-not-a-real-pinata-jwt";
  process.env.PINATA_GATEWAY_URL = "https://moolam-test.mypinata.cloud/ipfs/";
  return id;
});

const stubs = vi.hoisted(() => ({
  ensureSigner: vi.fn(),
  passportExists: vi.fn(async () => false),
  embeddedWallets: vi.fn(),
  chain: { now: 0n, owners: new Map<bigint, string>() },
}));

vi.mock("../src/c2pa.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/c2pa.js")>()),
  ensureSigner: stubs.ensureSigner,
}));

vi.mock("../src/edit/registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/edit/registry.js")>()),
  passportExists: stubs.passportExists,
}));

vi.mock("../src/auth/wallet.js", () => ({ embeddedWallets: stubs.embeddedWallets }));

vi.mock("../src/platform/chain.js", () => ({
  liveChain: () => ({
    now: async () => stubs.chain.now,
    agentOwner: async (agentId: bigint) => {
      const owner = stubs.chain.owners.get(agentId);
      if (owner === undefined) throw new Error("ERC721NonexistentToken");
      return owner;
    },
    passport: async () => undefined,
  }),
}));

const { buildServer } = await import("../src/server.js");
const { contentIdOf } = await import("../src/ipfs/pinata.js");
const { fingerprint } = await import("../src/fingerprint.js");
const { onboardingTypedData, recordMessage } = await import("../src/platforms/platforms.js");
const { prepareTypedData } = await import("../src/platform/signatures.js");
const { handleHash } = await import("../src/platform/pending.js");
const { SWORN_TEXT, StatementsRefused, registrantStatements } = await import("../src/statements.js");
const { SealedMetadataRefused, checkedSealedMetadata, sealedMetadata } = await import("../src/sealed.js");
type PassportRecord = import("../src/types.js").PassportRecord;

const UPLOAD_URL = "https://uploads.pinata.cloud/v3/files";
const AGENT_ID = 4343n;
const SWORN = { text: SWORN_TEXT, version: 1 };
const STRANGER = "0x2222222222222222222222222222222222222222" as Hex;

const agentOwner = privateKeyToAccount(`0x${"41".repeat(32)}`);
const platformCreator = privateKeyToAccount(`0x${"42".repeat(32)}`);
const KEY = randomBytes(32).toString("hex");
const KEY_HASH = `0x${createHash("sha256").update(Buffer.from(KEY, "hex")).digest("hex")}` as Hex;

const pins: { name: string; bytes: Buffer }[] = [];
let app: FastifyInstance;
let dir: string;
let signing: CryptoKey;
let address = 20;

/** Pictures made up front, so the index can hold an earlier passport of some of them. */
const pictures: Record<string, Buffer> = {};
/** The earlier passport seeded for each picture name that has one. */
const earlier: Record<string, PassportRecord> = {};

function sha256(bytes: Buffer): Hex {
  return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}

function caller(): string {
  address += 1;
  return `203.0.113.${address}`;
}

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

function multipart(fields: Record<string, string>, file: Buffer): { payload: Buffer; headers: Record<string, string> } {
  const boundary = "----moolamsworn";
  const chunks: Buffer[] = Object.entries(fields).map(([name, value]) =>
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`),
  );
  chunks.push(
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="picture.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return { payload: Buffer.concat(chunks), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

/** The document pinned by the request that ran between `mark` and now. */
function documentSince(mark: number): Record<string, unknown> | undefined {
  const pin = pins.slice(mark).find((one) => one.name.endsWith(".json") && !one.name.endsWith("-c2pa.json"));
  return pin === undefined ? undefined : (JSON.parse(pin.bytes.toString("utf8")) as Record<string, unknown>);
}

async function studioPrepare(picture: Buffer, fields: Record<string, string> = {}) {
  const body = multipart({ title: "Harbour", kind: "human", ...fields }, picture);
  const mark = pins.length;
  const response = await app.inject({
    method: "POST",
    url: "/prepare",
    payload: body.payload,
    headers: { ...body.headers, authorization: `Bearer ${await token("did:privy:studio-person")}` },
    remoteAddress: caller(),
  });
  return { status: response.statusCode, json: response.json() as Record<string, unknown>, document: documentSince(mark) };
}

async function platformPrepare(mode: "platform" | "cosign", picture: Buffer, extra: Record<string, string> = {}) {
  const nonce = `0x${randomBytes(32).toString("hex")}` as Hex;
  const issuedAt = stubs.chain.now;
  const signature = await agentOwner.signTypedData(
    prepareTypedData({ mode: mode === "platform" ? 0 : 1, pictureHash: sha256(picture), platformId: KEY_HASH, nonce, issuedAt }),
  );
  const body = multipart({ mode, title: "Lighthouse", nonce, issuedAt: issuedAt.toString(), signature, ...extra }, picture);
  const mark = pins.length;
  const response = await app.inject({
    method: "POST",
    url: "/platform/prepare",
    payload: body.payload,
    headers: { ...body.headers, authorization: `Bearer ${KEY}` },
    remoteAddress: caller(),
  });
  const json = response.json() as Record<string, unknown>;
  let document = documentSince(mark);
  if (mode === "cosign" && typeof json.handle === "string") {
    // Co-sign pins nothing before the agent signs, so the document is read where it was frozen.
    const frozen = path.join(dir, "platform-pending", handleHash(json.handle).slice(2), "metadata.bin");
    document = JSON.parse(readFileSync(frozen, "utf8")) as Record<string, unknown>;
  }
  return { status: response.statusCode, json, document, pinned: pins.length - mark };
}

/** An earlier passport of `picture` by `creator`, registered an hour ago. */
async function earlierOf(byte: number, picture: Buffer, creator: Hex): Promise<PassportRecord> {
  const print = await fingerprint(picture);
  return {
    id: idFrom(byte),
    phash: print.phash,
    blockhash: print.blockhash,
    creator,
    parentId: null,
    registeredAt: Math.floor(Date.now() / 1000) - 3_600,
    metadataURI: `ipfs://bafkearlier${byte}`,
  };
}

beforeAll(async () => {
  stubs.ensureSigner.mockResolvedValue(undefined);
  const pair = await generateKeyPair("ES256", { extractable: true });
  signing = pair.privateKey;
  dir = mkdtempSync(path.join(tmpdir(), "moolam-sworn-"));
  stubs.chain.now = BigInt(Math.floor(Date.now() / 1000));
  stubs.chain.owners.set(AGENT_ID, agentOwner.address);
  stubs.embeddedWallets.mockResolvedValue([]);

  let seed = 500;
  for (const name of ["studioMatch", "studioFresh", "sealedMatch", "platformMatch", "platformOwn", "cosignMatch", "refused"]) {
    pictures[name] = await makeImage((seed += 7));
  }
  earlier.studioMatch = await earlierOf(0x61, pictures.studioMatch as Buffer, STRANGER);
  earlier.sealedMatch = await earlierOf(0x62, pictures.sealedMatch as Buffer, STRANGER);
  earlier.platformMatch = await earlierOf(0x63, pictures.platformMatch as Buffer, STRANGER);
  earlier.platformOwn = await earlierOf(0x64, pictures.platformOwn as Buffer, platformCreator.address);
  earlier.cosignMatch = await earlierOf(0x65, pictures.cosignMatch as Buffer, STRANGER);

  const unsigned = {
    name: "Acme Images",
    agentId: AGENT_ID.toString(),
    ownerAtOnboarding: agentOwner.address,
    creatorWallet: platformCreator.address,
    keyHash: KEY_HASH,
    origins: ["https://acme.example"],
    validFrom: 1,
    acceptedAt: 1,
    ownerSignature: "",
    creatorSignature: "",
  };
  const typed = onboardingTypedData(recordMessage(unsigned));
  const entry = {
    ...unsigned,
    ownerSignature: await agentOwner.signTypedData(typed),
    creatorSignature: await platformCreator.signTypedData(typed),
  };

  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== UPLOAD_URL) throw new Error(`unexpected fetch to ${url}`);
    const form = init?.body as FormData;
    const bytes = Buffer.from(await (form.get("file") as File).arrayBuffer());
    pins.push({ name: String(form.get("name")), bytes });
    return new Response(JSON.stringify({ data: { cid: contentIdOf(bytes), size: bytes.length, network: "public" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  const seeded = Object.values(earlier);
  app = await buildServer({
    source: { load: async () => seeded },
    logger: false,
    prepare: {
      keys: pair.publicKey,
      lookalike: { walletsOf: async () => ["0x1111111111111111111111111111111111111111"], titleOf: async () => "Someone else's harbour" },
      webCheck: {},
    },
    platform: { keys: pair.publicKey, list: [entry], dir, lookalike: { titleOf: async () => "Lighthouse‮ at night\n" } },
  });
  await app.ready();
}, 120_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("L21: seenEarlier and the sworn line are the registrant's own words, checked before they are pinned", () => {
  it("builds the sworn line exactly, lower-cases seenEarlier, and refuses anything outside the shape", () => {
    const upper = `0x${"AB".repeat(32)}` as Hex;
    expect(registrantStatements({ voice: "sworn", seenEarlier: upper })).toEqual({ sworn: SWORN, seenEarlier: `0x${"ab".repeat(32)}` });
    expect(registrantStatements({ voice: { platformStatement: "Made by Acme's model at the user's request." } })).toEqual({
      platformStatement: "Made by Acme's model at the user's request.",
    });
    expect(registrantStatements({ voice: "none" })).toEqual({});

    const refused = [
      { voice: "sworn" as const, seenEarlier: "ipfs://bafkcid" as Hex },
      { voice: "sworn" as const, seenEarlier: `0x${"ab".repeat(31)}` as Hex },
      { voice: { platformStatement: "two\nlines" } },
      { voice: { platformStatement: " padded" } },
      { voice: { platformStatement: "x".repeat(1_001) } },
      { voice: "sworn" as const, seenOnline: { count: 1, pages: ["https://example.com/a?b=c"] } },
      { voice: "sworn" as const, seenOnline: { count: 1, pages: ["https://example.com/a", "https://example.com/b"] } },
      { voice: "sworn" as const, seenOnline: { count: 2, pages: ["javascript:alert(1)"] } },
      { voice: "sworn" as const, seenOnline: { count: 0, pages: [] } },
    ];
    for (const input of refused) {
      expect(() => registrantStatements(input), JSON.stringify(input)).toThrow(StatementsRefused);
    }
  });

  it("gives a sealed document the sworn line and seenEarlier, and no room at all for web pages", () => {
    const print = { phash: 1n, blockhash: `0x${"00".repeat(32)}` as Hex, sha256: idFrom(0x70), width: 1, height: 1 };
    const document = sealedMetadata({
      title: "Sealed",
      description: "d",
      passportId: idFrom(0x70),
      fingerprint: print as never,
      statements: registrantStatements({ voice: "sworn", seenEarlier: idFrom(0x71) }),
    });
    expect(document.sworn).toEqual(SWORN);
    expect(document.seenEarlier).toBe(idFrom(0x71));
    expect(() => checkedSealedMetadata({ ...document, seenOnline: { count: 1, pages: ["https://example.com/a"] } })).toThrow(SealedMetadataRefused);
    expect(() => checkedSealedMetadata({ ...document, sworn: { text: "I did not make this.", version: 1 } })).toThrow(SealedMetadataRefused);
  });

  it("pins the sworn line in every studio document, and seenEarlier only when the warning said found", async () => {
    const matched = await studioPrepare(pictures.studioMatch as Buffer);
    expect(matched.status).toBe(200);
    expect(matched.json.lookalike).toMatchObject({ state: "found", passportId: earlier.studioMatch?.id });
    expect(matched.document?.sworn).toEqual(SWORN);
    expect(matched.document?.seenEarlier).toBe(earlier.studioMatch?.id);

    const fresh = await studioPrepare(pictures.studioFresh as Buffer);
    expect(fresh.json.lookalike).toMatchObject({ state: "none" });
    expect(fresh.document?.sworn).toEqual(SWORN);
    expect(fresh.document).not.toHaveProperty("seenEarlier");
    expect(fresh.document).not.toHaveProperty("seenOnline");

    const sealed = await studioPrepare(pictures.sealedMatch as Buffer, { sealed: "true" });
    expect(sealed.status).toBe(200);
    expect(sealed.json.webCheck).toEqual({ state: "silent" });
    expect(sealed.document?.sealed).toBe(true);
    expect(sealed.document?.sworn).toEqual(SWORN);
    expect(sealed.document?.seenEarlier).toBe(earlier.sealedMatch?.id);
    expect(sealed.document).not.toHaveProperty("seenOnline");
  }, 120_000);
});

describe("/platform/prepare carries the look-alike warning and the registrant's statement end to end", () => {
  it("platform mode: answers found with a plain title, and pins the platform's statement and seenEarlier, never the sworn line", async () => {
    const statement = "Generated by Acme Images for one of its users, who accepted Acme's terms.";
    const answer = await platformPrepare("platform", pictures.platformMatch as Buffer, { platformStatement: statement });

    expect(answer.status).toBe(200);
    expect(answer.json.lookalike).toEqual({
      state: "found",
      passportId: earlier.platformMatch?.id,
      title: "Lighthouse at night",
      registeredAt: earlier.platformMatch?.registeredAt,
    });
    expect(answer.json).not.toHaveProperty("webCheck");
    expect(answer.document?.platformStatement).toBe(statement);
    expect(answer.document).not.toHaveProperty("sworn");
    expect(answer.document?.seenEarlier).toBe(earlier.platformMatch?.id);
    expect(answer.document).not.toHaveProperty("seenOnline");
  }, 60_000);

  it("platform mode: the platform's own earlier passport is yours, with no seenEarlier, and no statement sent means none pinned", async () => {
    const answer = await platformPrepare("platform", pictures.platformOwn as Buffer);

    expect(answer.status).toBe(200);
    expect(answer.json.lookalike).toEqual({ state: "yours", passportId: earlier.platformOwn?.id });
    expect(answer.document).not.toHaveProperty("seenEarlier");
    expect(answer.document).not.toHaveProperty("sworn");
    expect(answer.document).not.toHaveProperty("platformStatement");
  }, 60_000);

  it("co-sign mode: warns about any earlier passport, and freezes the sworn line the person signs on the co-sign page", async () => {
    const answer = await platformPrepare("cosign", pictures.cosignMatch as Buffer);

    expect(answer.status).toBe(200);
    expect(answer.pinned).toBe(0);
    expect(answer.json.lookalike).toMatchObject({ state: "found", passportId: earlier.cosignMatch?.id });
    expect(answer.document?.sworn).toEqual(SWORN);
    expect(answer.document?.seenEarlier).toBe(earlier.cosignMatch?.id);
    expect(answer.document).not.toHaveProperty("platformStatement");
  }, 60_000);

  it("refuses a platformStatement in co-sign mode or outside its shape before anything is spent", async () => {
    for (const [mode, statement] of [
      ["cosign", "Acme's words"],
      ["platform", "line one\nline two"],
      ["platform", `${"é".repeat(501)}`],
      ["platform", "‮reversed"],
    ] as const) {
      const answer = await platformPrepare(mode, pictures.refused as Buffer, { platformStatement: statement });
      expect(answer.status, statement).toBe(400);
      expect(answer.pinned).toBe(0);
    }
  }, 60_000);
});

describe("L25: a document's statement says which road it came by", () => {
  it("gives every studio and co-sign document the sworn line and every platform document at most the platform's words, never both", () => {
    const studioDocuments = pins
      .filter((pin) => pin.name.endsWith(".json") && !pin.name.endsWith("-c2pa.json"))
      .map((pin) => JSON.parse(pin.bytes.toString("utf8")) as Record<string, unknown>);
    expect(studioDocuments.length).toBeGreaterThanOrEqual(5);
    for (const document of studioDocuments) {
      const voices = ["sworn", "platformStatement"].filter((key) => key in document);
      expect(voices.length, JSON.stringify(document)).toBeLessThanOrEqual(1);
      if (typeof document.generator === "object" && (document.generator as { agentId: string }).agentId === AGENT_ID.toString()) {
        expect(document).not.toHaveProperty("sworn");
      } else {
        expect(document.sworn).toEqual(SWORN);
      }
    }
  });
});
