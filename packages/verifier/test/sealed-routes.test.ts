// Covers opt-in B's second step, the three routes that touch a kept private copy and the queue's
// use of them, against the promises of "The private re-check" in docs/security/threat-model.md. GET
// /sealed/status says kept, gone or unknown and never shows unknown as either of the others, with
// its memory and cache rules and its own rate limit (B10). POST /sealed/link refuses in one fixed
// order, each refusal without a URL or a file id (B1, B3, B4), mints only for a
// claim under ten minutes old (D3), for a fixed 120 seconds and under both caps (B15), and never
// logs the link or the token (B5). POST /sealed/forget deletes only for the holder and only on a
// listing that finished, every file under the name (B9). The queue takes a privately re-checkable
// passport while its copy is kept or unknown and refuses it once gone (B11). Each test names the
// invariant it holds.
// Does NOT cover the runner or the sealed workflow, the sweep of copies whose passport never
// registered (sweep.test.ts), or a real call to Pinata, Privy, the chain or the gateway:
// the chain read, the document read and the holder's wallets are stubbed, and Pinata is a
// recording stub at the fetch layer, so the Pinata client's own checks run for real.

import fs from "node:fs";
import { SignJWT, generateKeyPair } from "jose";
import { getAddress, type Hex } from "viem";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { QueueStore, RecheckItem } from "../src/recheck/queue.js";
import type { PassportRecord } from "../src/types.js";

const APP_ID = vi.hoisted(() => {
  const id = "moolamtestapp0000011";
  process.env.PRIVY_APP_ID = id;
  process.env.PINATA_JWT = "test-token-not-a-real-pinata-jwt";
  process.env.PINATA_GATEWAY_URL = "https://moolam-test.mypinata.cloud/ipfs/";
  process.env.X402_ENABLED = "false";
  process.env.GENERATOR_WALLET_ID = "";
  process.env.EXPECT_ROUTES = "";
  process.env.RUNNER_TOKEN = "";
  process.env.SEALED_LINK_TOKEN = "";
  return id;
});

const stubs = vi.hoisted(() => ({
  readPassport: vi.fn(),
  holderOf: vi.fn(),
  readMetadataDocument: vi.fn(),
  embeddedWallets: vi.fn(),
}));

vi.mock("../src/unseal.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/unseal.js")>()),
  readPassport: stubs.readPassport,
  holderOf: stubs.holderOf,
  readMetadataDocument: stubs.readMetadataDocument,
}));

vi.mock("../src/auth/wallet.js", () => ({ embeddedWallets: stubs.embeddedWallets }));

vi.mock("../src/generate/privy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/generate/privy.js")>()),
  privy: () => ({}),
}));

const { buildServer } = await import("../src/server.js");
const { sealedMetadata } = await import("../src/sealed.js");
const { env } = await import("../src/env.js");

const PRIVATE_FILES_URL = "https://api.pinata.cloud/v3/files/private";
const LINK_URL = `${PRIVATE_FILES_URL}/download_link`;
const GATEWAY_HOST = "moolam-test.mypinata.cloud";
const SIGNATURE = "c2VjcmV0LXNpZ25hdHVyZS1mb3ItdGVzdHM";
const HOLDER = getAddress("0x85a88ca81ff5f681d96ab86fa60ccb8452a139a6");
const STRANGER = getAddress("0x1111111111111111111111111111111111111111");

/** A passport id built from one repeated byte, lower case, as the edge makes every id. */
function idOf(byte: number): Hex {
  return `0x${byte.toString(16).padStart(2, "0").repeat(32)}` as Hex;
}

function nameOf(id: Hex): string {
  return `sealed-thumb-${id}.jpg`;
}

/** What the chain holds: passport id to metadataURI. An id missing here is not registered. */
const chain = new Map<Hex, string>();
/** Ids whose chain read throws, as an RPC that timed out does. */
const chainDown = new Set<Hex>();
/** What the gateway serves: metadataURI to document. A URI missing here fails the read. */
const documents = new Map<string, unknown>();

/** A sealed document as /prepare writes it, asking for a private re-check unless told otherwise. */
function sealedDocument(id: Hex, privateRecheck = true): unknown {
  return sealedMetadata({
    title: "Harbour kept private",
    description: "A picture registered with Moolam and kept sealed.",
    passportId: id,
    fingerprint: {
      sha256: id,
      phash: 7840506850305415717n,
      blockhash: `0x${"11".repeat(32)}` as Hex,
      width: 640,
      height: 480,
      format: "jpeg",
    },
    privateRecheck: privateRecheck ? true : undefined,
    createdAt: new Date("2026-09-23T08:00:00Z"),
  });
}

/** Puts a passport on the stub chain with the document given behind it. */
function register(id: Hex, document: unknown): void {
  chain.set(id, `ipfs://doc-${id}`);
  documents.set(`ipfs://doc-${id}`, document);
}

/** One private file on the stub Pinata account. */
interface Kept {
  id: string;
  name: string;
  cid: string;
}

const account: Kept[] = [];
let fileCounter = 0;

function keep(name: string): Kept {
  fileCounter += 1;
  const file = {
    id: `0199a3c2-5d7e-7f10-9a1b-${fileCounter.toString(16).padStart(12, "0")}`,
    name,
    cid: `bafkreiprivate${fileCounter.toString().padStart(30, "0")}`,
  };
  account.push(file);
  return file;
}

/** One request the stub Pinata saw. */
interface Call {
  kind: "list" | "link" | "delete";
  url: string;
  name?: string;
  body?: Record<string, unknown>;
}

const calls: Call[] = [];
const pinata = {
  /** Names whose listing answers 500. */
  listFails: new Set<string>(),
  /** Replaces the signed link answer when set. */
  linkAnswer: undefined as undefined | ((cid: string) => Response),
  /** File ids whose delete answers 500. */
  deleteFails: new Set<string>(),
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function signedLink(cid: string): string {
  return `https://${GATEWAY_HOST}/files/${cid}?X-Algorithm=PINATA1&X-Date=1790150000&X-Expires=120&X-Method=GET&X-Signature=${SIGNATURE}`;
}

/**
 * Pinata at the fetch layer. The listing answers every file whose name starts with the filter, a
 * looser rule than any real filter could be, so the exact-name check in our code is what is tested.
 * Anything else that tries to leave the process fails the test.
 */
function stubPinata(): void {
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? "GET";
    if (url.startsWith(`${PRIVATE_FILES_URL}?`) && method === "GET") {
      const name = new URL(url).searchParams.get("name") ?? "";
      calls.push({ kind: "list", url, name });
      if (pinata.listFails.has(name)) {
        return new Response("down", { status: 500 });
      }
      const files = account
        .filter((file) => file.name.startsWith(name))
        .map((file) => ({ id: file.id, name: file.name, cid: file.cid, created_at: "2026-09-23T08:00:00Z" }));
      return json({ data: { files, next_page_token: "" } });
    }
    if (url === LINK_URL && method === "POST") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ kind: "link", url, body });
      const cid = new URL(String(body.url)).pathname.replace("/files/", "");
      return pinata.linkAnswer?.(cid) ?? json({ data: signedLink(cid) });
    }
    if (url.startsWith(`${PRIVATE_FILES_URL}/`) && method === "DELETE") {
      const fileId = url.slice(PRIVATE_FILES_URL.length + 1);
      calls.push({ kind: "delete", url });
      if (pinata.deleteFails.has(fileId)) {
        return new Response("down", { status: 500 });
      }
      const at = account.findIndex((file) => file.id === fileId);
      if (at !== -1) {
        account.splice(at, 1);
      }
      return json({ data: null });
    }
    throw new Error("this test makes no live call");
  });
}

function callsSince(mark: number, kind?: Call["kind"]): Call[] {
  return calls.slice(mark).filter((call) => kind === undefined || call.kind === kind);
}

function indexRecord(id: Hex): PassportRecord {
  return {
    id,
    phash: 7840506850305415717n,
    blockhash: `0x${"11".repeat(32)}` as Hex,
    creator: HOLDER,
    parentId: null,
    registeredAt: 1_757_000_000,
    metadataURI: `ipfs://doc-${id}`,
  };
}

function storeOf(items: RecheckItem[]): QueueStore {
  let held = items;
  return { read: () => ({ items: held }), write: (next) => (held = [...next]) };
}

const LINK_TOKEN = "moolam-sealed-link-token-for-tests-0001";
const MINUTE = 60 * 1000;
const STARTED = Date.now();

function running(id: Hex, minutesAgo: number): RecheckItem {
  return {
    passportId: id,
    status: "running",
    requestedAt: STARTED - (minutesAgo + 1) * MINUTE,
    requestedBy: "public",
    startedAt: STARTED - minutesAgo * MINUTE,
  };
}

/** The passports the link tests use, each set up for the one check it exercises. */
const L = {
  ok: idOf(0x20),
  nine: idOf(0x21),
  eleven: idOf(0x22),
  pending: idOf(0x23),
  done: idOf(0x24),
  gone: idOf(0x25),
  two: idOf(0x26),
  listFails: idOf(0x27),
  unregistered: idOf(0x28),
  chainDown: idOf(0x29),
  docDown: idOf(0x2a),
  plain: idOf(0x2b),
  other: idOf(0x2c),
  capped: idOf(0x2d),
  foreign: idOf(0x2e),
  expiry: idOf(0x2f),
};

/** The passports the queue tests ask the re-check queue about. */
const Q = {
  kept: idOf(0x60),
  gone: idOf(0x61),
  plain: idOf(0x62),
  unknown: idOf(0x63),
};

/** Passports the index holds, for the queue tests: the queue only takes passports the index knows. */
const indexed: Hex[] = [Q.kept, Q.gone, Q.plain, Q.unknown];
/** Requests the queue starts with, for the claim window tests. */
const queued: RecheckItem[] = [
  running(L.ok, 1),
  running(L.nine, 9),
  running(L.eleven, 11),
  { passportId: L.pending, status: "pending", requestedAt: STARTED - MINUTE, requestedBy: "public" },
  {
    passportId: L.done,
    status: "done",
    requestedAt: STARTED - 3 * MINUTE,
    requestedBy: "public",
    startedAt: STARTED - 2 * MINUTE,
    finishedAt: STARTED - MINUTE,
    reportTx: `0x${"ab".repeat(32)}`,
  },
  running(L.gone, 1),
  running(L.two, 1),
  running(L.listFails, 1),
  running(L.plain, 1),
  running(L.other, 1),
  running(L.capped, 1),
  running(L.foreign, 1),
  running(L.expiry, 1),
];

let app: FastifyInstance;
let signing: CryptoKey;
let verifying: CryptoKey;

async function privyToken(subject: string): Promise<string> {
  return await new SignJWT({})
    .setProtectedHeader({ alg: "ES256" })
    .setIssuer("privy.io")
    .setAudience(APP_ID)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(signing);
}

async function forget(
  passportId: unknown,
  subject: string | null,
  on: FastifyInstance = app,
): Promise<LightMyRequestResponse> {
  return await on.inject({
    method: "POST",
    url: "/sealed/forget",
    payload: { passportId },
    headers: subject === null ? {} : { authorization: `Bearer ${await privyToken(subject)}` },
    remoteAddress: "198.51.100.90",
  });
}

async function build(extra: Parameters<typeof buildServer>[0] = {}): Promise<FastifyInstance> {
  const server = await buildServer({
    source: { load: async () => indexed.map(indexRecord) },
    logger: false,
    recheck: {
      readDocument: async (uri: string) => await stubs.readMetadataDocument(uri),
      findRecord: async () => undefined,
      store: storeOf(queued.map((item) => ({ ...item }))),
    },
    sealed: { linkToken: LINK_TOKEN, keys: verifying },
    ...extra,
  });
  await server.ready();
  return server;
}

async function link(
  passportId: unknown,
  options: { on?: FastifyInstance; token?: string | null; ip?: string; body?: Record<string, unknown> } = {},
): Promise<LightMyRequestResponse> {
  const token = options.token === undefined ? LINK_TOKEN : options.token;
  return await (options.on ?? app).inject({
    method: "POST",
    url: "/sealed/link",
    payload: options.body ?? { passportId },
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    remoteAddress: options.ip ?? "198.51.100.40",
  });
}

/** A refusal carries no URL, no signature and nothing of the file: not its id and not its content id. */
function expectNothingOfTheFile(response: LightMyRequestResponse): void {
  expect(response.body).not.toContain("https://");
  expect(response.body).not.toContain(SIGNATURE);
  expect(response.body).not.toContain("bafkreiprivate");
  expect(response.body).not.toContain("0199a3c2");
  expect(response.json().url).toBeUndefined();
}

/** Everything this service writes to the console while `work` runs, by every road pino may use. */
async function captureLog<T>(work: () => Promise<T>): Promise<{ result: T; logged: string }> {
  const lines: string[] = [];
  const keep = (chunk: unknown): void => {
    if (typeof chunk === "string") lines.push(chunk);
    else if (chunk instanceof Uint8Array) lines.push(Buffer.from(chunk).toString("utf8"));
  };
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    keep(chunk);
    return true;
  });
  const patched = fs as unknown as Record<string, unknown>;
  const realWrite = fs.write;
  const realWriteSync = fs.writeSync;
  patched.write = (...args: unknown[]): unknown => {
    if (args[0] === 1) {
      keep(args[1]);
      const done = args.find((arg) => typeof arg === "function") as ((...rest: unknown[]) => void) | undefined;
      done?.(null, typeof args[1] === "string" ? Buffer.byteLength(args[1]) : (args[1] as Uint8Array).length);
      return undefined;
    }
    return (realWrite as unknown as (...rest: unknown[]) => unknown)(...args);
  };
  patched.writeSync = (...args: unknown[]): unknown => {
    if (args[0] === 1) {
      keep(args[1]);
      return typeof args[1] === "string" ? Buffer.byteLength(args[1]) : (args[1] as Uint8Array).length;
    }
    return (realWriteSync as unknown as (...rest: unknown[]) => unknown)(...args);
  };
  try {
    const result = await work();
    await new Promise((resolve) => setTimeout(resolve, 150));
    return { result, logged: lines.join("") };
  } finally {
    patched.write = realWrite;
    patched.writeSync = realWriteSync;
    stdout.mockRestore();
  }
}

async function status(id: string, ip = "198.51.100.20", on: FastifyInstance = app): Promise<LightMyRequestResponse> {
  return await on.inject({ method: "GET", url: `/sealed/status/${id}`, remoteAddress: ip });
}

beforeAll(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  signing = pair.privateKey;
  verifying = pair.publicKey;
  stubs.holderOf.mockResolvedValue(HOLDER);
  stubs.embeddedWallets.mockImplementation(async (_client: unknown, userId: string) =>
    userId === "did:privy:holder" ? [HOLDER] : [STRANGER],
  );
  stubs.readPassport.mockImplementation(async (_client: unknown, _registry: unknown, id: Hex) => {
    if (chainDown.has(id)) {
      throw new Error("the RPC timed out");
    }
    const metadataURI = chain.get(id);
    return metadataURI === undefined
      ? undefined
      : { registeredAt: 1_757_000_000, phash: 1n, blockhash256: `0x${"11".repeat(32)}`, fingerprintVersion: 1, metadataURI };
  });
  stubs.readMetadataDocument.mockImplementation(async (uri: string) => {
    if (!documents.has(uri)) {
      throw new Error("the gateway answered 504 for this passport's metadata");
    }
    return documents.get(uri);
  });
  stubPinata();
  app = await build();
});

afterEach(() => {
  pinata.listFails.clear();
  pinata.linkAnswer = undefined;
  pinata.deleteFails.clear();
  vi.useRealTimers();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await app.close();
});

describe("GET /sealed/status/:passportId (B10)", () => {
  it("B10: says kept when exactly one file has the name, and lets a cache hold it for a minute", async () => {
    const id = idOf(0x10);
    register(id, sealedDocument(id));
    keep(nameOf(id));

    const response = await status(id);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ passportId: id, state: "kept", privateRecheck: true });
    expect(response.headers["cache-control"]).toBe("public, max-age=60");
  });

  it("B10: says gone only from a listing that finished and found none, cached like kept", async () => {
    const id = idOf(0x11);
    register(id, sealedDocument(id));

    const response = await status(id);

    expect(response.json()).toEqual({ passportId: id, state: "gone", privateRecheck: true });
    expect(response.headers["cache-control"]).toBe("public, max-age=60");
  });

  it("B10: says unknown, never gone, when the listing fails, and holds nothing, so the next read asks again", async () => {
    const id = idOf(0x12);
    register(id, sealedDocument(id));
    pinata.listFails.add(nameOf(id));

    const mark = calls.length;
    const first = await status(id);
    const second = await status(id);

    expect(first.json()).toEqual({ passportId: id, state: "unknown", privateRecheck: true });
    expect(first.headers["cache-control"]).toBe("no-store");
    expect(second.json().state).toBe("unknown");
    expect(callsSince(mark, "list")).toHaveLength(2);
  });

  it("B10: says unknown when the document or the chain cannot be read, and never asks Pinata", async () => {
    const unreadable = idOf(0x13);
    chain.set(unreadable, "ipfs://doc-nowhere");
    const noChain = idOf(0x14);
    chainDown.add(noChain);

    const mark = calls.length;
    const document = await status(unreadable);
    const rpc = await status(noChain);

    for (const response of [document, rpc]) {
      expect(response.statusCode).toBe(200);
      expect(response.json().state).toBe("unknown");
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    expect(callsSince(mark)).toHaveLength(0);
  });

  it("B10: says unknown when two files share the name, and ignores a file whose name only starts the same", async () => {
    const twice = idOf(0x15);
    register(twice, sealedDocument(twice));
    keep(nameOf(twice));
    keep(nameOf(twice));
    const lookalike = idOf(0x16);
    register(lookalike, sealedDocument(lookalike));
    keep(`${nameOf(lookalike)}.old`);

    expect((await status(twice)).json().state).toBe("unknown");
    expect((await status(lookalike)).json()).toEqual({ passportId: lookalike, state: "gone", privateRecheck: true });
  });

  it("answers privateRecheck false and gone without calling Pinata for a document that did not ask", async () => {
    const plain = idOf(0x17);
    register(plain, sealedDocument(plain, false));
    const open = idOf(0x18);
    register(open, { name: "a public picture", image: "ipfs://bafypicture" });

    const mark = calls.length;
    for (const id of [plain, open]) {
      const response = await status(id);
      expect(response.json()).toEqual({ passportId: id, state: "gone", privateRecheck: false });
      expect(response.headers["cache-control"]).toBe("public, max-age=60");
    }
    expect(callsSince(mark)).toHaveLength(0);
  });

  it("B1: treats a document whose commitment names another passport as not asking, and lists nothing", async () => {
    const id = idOf(0x19);
    register(id, sealedDocument(idOf(0x10)));
    keep(nameOf(id));

    const mark = calls.length;
    const response = await status(id);

    expect(response.json()).toEqual({ passportId: id, state: "gone", privateRecheck: false });
    expect(callsSince(mark)).toHaveLength(0);
  });

  it("holds kept and gone for 60 seconds per id, then reads again", async () => {
    const id = idOf(0x1a);
    register(id, sealedDocument(id));
    keep(nameOf(id));
    vi.useFakeTimers({ toFake: ["Date"] });

    const mark = calls.length;
    await status(id);
    await status(id);
    expect(callsSince(mark, "list")).toHaveLength(1);

    vi.setSystemTime(Date.now() + 59_000);
    await status(id);
    expect(callsSince(mark, "list")).toHaveLength(1);

    vi.setSystemTime(Date.now() + 2_000);
    await status(id);
    expect(callsSince(mark, "list")).toHaveLength(2);
  });

  it("answers 404 no-passport, not cacheable, for an id the chain does not hold, and 400 for one that is not an id", async () => {
    const missing = await status(idOf(0x1b));
    const bad = await status("0x1234");

    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "no-passport", passportId: idOf(0x1b) });
    expect(missing.headers["cache-control"]).toBe("no-store");
    expect(bad.statusCode).toBe(400);
  });

  it("lower-cases the id once at the edge, so the same passport in capitals is the same answer", async () => {
    const id = idOf(0x1c);
    register(id, sealedDocument(id));
    keep(nameOf(id));

    const response = await status(id.toUpperCase().replace("0X", "0x"));

    expect(response.json()).toEqual({ passportId: id, state: "kept", privateRecheck: true });
  });

  it("allows thirty a minute per caller and refuses the thirty-first", async () => {
    const id = idOf(0x10);
    const codes: number[] = [];
    for (let i = 0; i < 31; i += 1) {
      codes.push((await status(id, "198.51.100.230")).statusCode);
    }

    expect(codes.slice(0, 30).every((code) => code === 200)).toBe(true);
    expect(codes[30]).toBe(429);
  });
});

describe("POST /sealed/link (B1, B3, B4, B5, B15, D3)", () => {
  beforeAll(() => {
    for (const id of [L.ok, L.nine, L.eleven, L.pending, L.done, L.capped, L.foreign, L.expiry, L.listFails]) {
      register(id, sealedDocument(id));
      keep(nameOf(id));
    }
    register(L.gone, sealedDocument(L.gone));
    register(L.two, sealedDocument(L.two));
    keep(nameOf(L.two));
    keep(nameOf(L.two));
    chainDown.add(L.chainDown);
    chain.set(L.docDown, "ipfs://doc-unreadable");
    register(L.plain, sealedDocument(L.plain, false));
    register(L.other, sealedDocument(L.ok));
  });

  it("answers 503 not-configured on a host with no SEALED_LINK_TOKEN, whatever token is sent", async () => {
    const off = await build({ sealed: {} });
    try {
      const response = await link(L.ok, { on: off });

      expect(response.statusCode).toBe(503);
      expect(response.json().error).toBe("not-configured");
      expectNothingOfTheFile(response);
    } finally {
      await off.close();
    }
  });

  it("B4: answers 401 for a missing token and for a wrong one, before reading anything", async () => {
    const mark = calls.length;
    stubs.readPassport.mockClear();
    const missing = await link(L.ok, { token: null });
    const wrong = await link(L.ok, { token: "moolam-sealed-link-token-for-tests-9999" });

    for (const response of [missing, wrong]) {
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "unauthorized" });
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    expect(stubs.readPassport).not.toHaveBeenCalled();
    expect(callsSince(mark)).toHaveLength(0);
  });

  it("refuses 400 for an id that is not 32 bytes of hex", async () => {
    for (const passportId of ["0x1234", `0x${"zz".repeat(32)}`, 42, undefined]) {
      const response = await link(passportId);
      expect(response.statusCode).toBe(400);
      expectNothingOfTheFile(response);
    }
  });

  it("B4: refuses 404 no-passport when the registry does not hold the id, and 503 when the read failed", async () => {
    const mark = calls.length;
    const missing = await link(L.unregistered);
    const down = await link(L.chainDown);

    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "no-passport", passportId: L.unregistered });
    expect(down.statusCode).toBe(503);
    expect(down.json()).toEqual({ error: "chain-unavailable", passportId: L.chainDown });
    expectNothingOfTheFile(missing);
    expectNothingOfTheFile(down);
    expect(callsSince(mark)).toHaveLength(0);
  });

  it("B4: refuses 503 when the document cannot be read, and 404 nothing-kept when it did not ask", async () => {
    const mark = calls.length;
    const unreadable = await link(L.docDown);
    const plain = await link(L.plain);

    expect(unreadable.statusCode).toBe(503);
    expect(unreadable.json().error).toBe("metadata-unavailable");
    expect(plain.statusCode).toBe(404);
    expect(plain.json().error).toBe("nothing-kept");
    expectNothingOfTheFile(unreadable);
    expectNothingOfTheFile(plain);
    expect(callsSince(mark)).toHaveLength(0);
  });

  it("B1: refuses 409 commitment-mismatch when the document commits to another passport, and lists no file", async () => {
    const mark = calls.length;
    const response = await link(L.other);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "commitment-mismatch", passportId: L.other });
    expectNothingOfTheFile(response);
    expect(callsSince(mark)).toHaveLength(0);
  });

  it("D3: mints for a passport claimed 9 minutes ago", async () => {
    const response = await link(L.nine);

    expect(response.statusCode).toBe(200);
    expect(response.json().url).toContain(`https://${GATEWAY_HOST}/files/`);
  });

  it("D3: refuses 409 not-claimed for a claim 11 minutes old, a pending request and a done one, and lists no file", async () => {
    const mark = calls.length;
    for (const id of [L.eleven, L.pending, L.done]) {
      const response = await link(id);
      expect(response.statusCode, id).toBe(409);
      expect(response.json()).toEqual({ error: "not-claimed", passportId: id });
      expectNothingOfTheFile(response);
    }
    expect(callsSince(mark)).toHaveLength(0);
  });

  it("B3: refuses 404 gone when no file has the name, 409 ambiguous for two, and 503 when the listing failed", async () => {
    pinata.listFails.add(nameOf(L.listFails));
    const mark = calls.length;
    const gone = await link(L.gone);
    const two = await link(L.two);
    const down = await link(L.listFails);

    expect(gone.statusCode).toBe(404);
    expect(gone.json().error).toBe("gone");
    expect(two.statusCode).toBe(409);
    expect(two.json().error).toBe("ambiguous");
    expect(down.statusCode).toBe(503);
    expect(down.json().error).toBe("lookup-unavailable");
    for (const response of [gone, two, down]) {
      expectNothingOfTheFile(response);
    }
    expect(callsSince(mark, "link")).toHaveLength(0);
  });

  it("B4: mints a link for the one file under the name, on the dedicated gateway, answering only url and expiresAt", async () => {
    const file = account.find((one) => one.name === nameOf(L.ok)) as Kept;
    const mark = calls.length;
    const before = Date.now();
    const response = await link(L.ok.toUpperCase().replace("0X", "0x"));

    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.json()).sort()).toEqual(["expiresAt", "url"]);
    const url = new URL(response.json().url as string);
    expect(url.protocol).toBe("https:");
    expect(url.host).toBe(GATEWAY_HOST);
    expect(url.pathname).toBe(`/files/${file.cid}`);
    expect(response.headers["cache-control"]).toBe("no-store");
    const expires = Date.parse(response.json().expiresAt as string);
    expect(expires).toBeGreaterThanOrEqual(before + 119_000);
    expect(expires).toBeLessThanOrEqual(Date.now() + 120_000);

    const lookups = callsSince(mark, "list");
    expect(lookups.map((call) => call.name)).toEqual([nameOf(L.ok)]);
  });

  it("B15: asks Pinata for 120 seconds whatever the request says", async () => {
    const mark = calls.length;
    const response = await link(undefined, { body: { passportId: L.expiry, expires: 86_400, expiresSeconds: 86_400 } });

    expect(response.statusCode).toBe(200);
    const minted = callsSince(mark, "link");
    expect(minted).toHaveLength(1);
    expect(minted[0]?.body?.expires).toBe(120);
    expect(minted[0]?.body?.method).toBe("GET");
  });

  it("standard 3: refuses 502 with no URL when Pinata answers a link on another host", async () => {
    pinata.linkAnswer = (cid) =>
      json({ data: `https://evil.example/files/${cid}?X-Algorithm=PINATA1&X-Signature=${SIGNATURE}` });

    const response = await link(L.foreign);

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "link-unavailable", passportId: L.foreign });
    expectNothingOfTheFile(response);
    expect(response.body).not.toContain("evil.example");
  });

  it("B15: gives one passport five links an hour and refuses the sixth with 429 link-cap", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      codes.push((await link(L.capped, { ip: `198.51.100.${60 + i}` })).statusCode);
    }
    const sixth = await link(L.capped, { ip: "198.51.100.70" });

    expect(codes).toEqual([200, 200, 200, 200, 200]);
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json()).toEqual({ error: "link-cap", passportId: L.capped });
  });

  it("B15: mints at most 100 links a day across all passports, and /health shows the count", async () => {
    const ids = Array.from({ length: 21 }, (_, i) => idOf(0x40 + i));
    for (const id of ids) {
      register(id, sealedDocument(id));
      keep(nameOf(id));
    }
    const day = await build({
      recheck: {
        readDocument: async (uri: string) => await stubs.readMetadataDocument(uri),
      findRecord: async () => undefined,
        store: storeOf(ids.map((id) => running(id, 1))),
      },
    });
    try {
      let minted = 0;
      for (const [n, id] of ids.slice(0, 20).entries()) {
        for (let i = 0; i < 5; i += 1) {
          const response = await link(id, { on: day, ip: `203.0.113.${n + 1}` });
          if (response.statusCode === 200) minted += 1;
        }
      }
      const refused = await link(ids[20], { on: day, ip: "203.0.113.99" });
      const health = await day.inject({ method: "GET", url: "/health" });

      expect(minted).toBe(100);
      expect(refused.statusCode).toBe(429);
      expect(refused.json().error).toBe("global-limit");
      expectNothingOfTheFile(refused);
      expect(health.json().limits.links).toEqual({ used: 100, max: 100 });
    } finally {
      await day.close();
    }
  }, 60_000);

  it("B15: GLOBAL_LINKS_PER_DAY at 0 is the kill switch: the global-limit refusal, and no link asked of Pinata", async () => {
    const id = idOf(0x5a);
    register(id, sealedDocument(id));
    keep(nameOf(id));
    // env.ts parses once per file, so the switch is flipped on the parsed value for one server only.
    const ceiling = env.GLOBAL_LINKS_PER_DAY;
    env.GLOBAL_LINKS_PER_DAY = 0;
    let off: FastifyInstance | undefined;
    try {
      off = await build({
        recheck: {
          readDocument: async (uri: string) => await stubs.readMetadataDocument(uri),
          findRecord: async () => undefined,
          store: storeOf([running(id, 1)]),
        },
      });
      const mark = calls.length;
      const refused = await link(id, { on: off, ip: "203.0.113.120" });
      const health = await off.inject({ method: "GET", url: "/health" });

      expect(refused.statusCode).toBe(429);
      expect(refused.json().error).toBe("global-limit");
      expect(refused.headers["retry-after"]).toBeDefined();
      expectNothingOfTheFile(refused);
      expect(callsSince(mark, "link")).toHaveLength(0);
      expect(health.json().limits.links).toEqual({ used: 0, max: 0 });
    } finally {
      env.GLOBAL_LINKS_PER_DAY = ceiling;
      await off?.close();
    }
  });

  it("B5: no log line carries the link, its signature or the token, on a success or on any refusal", async () => {
    const logged = await build({ logger: true });
    pinata.listFails.add(nameOf(L.listFails));
    try {
      const { result, logged: text } = await captureLog(async () => {
        const answers: LightMyRequestResponse[] = [];
        answers.push(await link(L.ok, { on: logged }));
        answers.push(await link(L.ok, { on: logged, token: "moolam-sealed-link-token-for-tests-9999" }));
        answers.push(await link("0x1234", { on: logged }));
        for (const id of [L.unregistered, L.chainDown, L.docDown, L.plain, L.other, L.eleven, L.gone, L.two, L.listFails]) {
          answers.push(await link(id, { on: logged }));
        }
        pinata.linkAnswer = (cid) =>
          json({ data: `https://evil.example/files/${cid}?X-Algorithm=PINATA1&X-Signature=${SIGNATURE}` });
        answers.push(await link(L.foreign, { on: logged }));
        return answers;
      });

      expect(result[0]?.statusCode).toBe(200);
      const minted = result[0]?.json().url as string;
      expect(result.slice(1).every((response) => response.statusCode >= 400)).toBe(true);
      expect(text).toContain("sealed: private link minted");
      expect(text).toContain("rejected: /sealed/link");
      for (const secret of [LINK_TOKEN, minted, SIGNATURE, "X-Signature", "download_link", "evil.example"]) {
        expect(text, secret).not.toContain(secret);
      }
    } finally {
      await logged.close();
    }
  });
});

describe("POST /sealed/forget (B9)", () => {
  const F = {
    kept: idOf(0x30),
    stranger: idOf(0x31),
    listFails: idOf(0x32),
    two: idOf(0x33),
    plain: idOf(0x34),
    unregistered: idOf(0x35),
    partial: idOf(0x36),
    unknownUser: idOf(0x37),
  };

  beforeAll(() => {
    for (const id of [F.kept, F.stranger, F.listFails, F.partial, F.unknownUser]) {
      register(id, sealedDocument(id));
      keep(nameOf(id));
    }
    register(F.two, sealedDocument(F.two));
    keep(nameOf(F.two));
    keep(nameOf(F.two));
    keep(`${nameOf(F.two)}.old`);
    register(F.plain, sealedDocument(F.plain, false));
  });

  function held(id: Hex): Kept[] {
    return account.filter((file) => file.name === nameOf(id));
  }

  it("B9: deletes the copy for the holder, answers the count and no file id, and status reads gone at once", async () => {
    const file = held(F.kept)[0] as Kept;
    expect((await status(F.kept)).json().state).toBe("kept");

    const response = await forget(F.kept, "did:privy:holder");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ passportId: F.kept, deleted: 1 });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).not.toContain(file.id);
    expect(response.body).not.toContain(file.cid);
    expect(held(F.kept)).toHaveLength(0);
    expect(stubs.holderOf).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), F.kept);

    const after = await status(F.kept);
    expect(after.json()).toEqual({ passportId: F.kept, state: "gone", privateRecheck: true });
  });

  it("B9: refuses a stranger with 403 not-holder and deletes nothing", async () => {
    const mark = calls.length;
    const response = await forget(F.stranger, "did:privy:stranger");

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "not-holder", passportId: F.stranger });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(held(F.stranger)).toHaveLength(1);
    expect(callsSince(mark)).toHaveLength(0);
  });

  it("B9: refuses a Privy user this app does not know with 403, and a missing token with 401", async () => {
    const { APIError } = await import("@privy-io/node");
    stubs.embeddedWallets.mockRejectedValueOnce(new APIError(404, { code: "not_found" }, "no user", undefined));
    const unknownUser = await forget(F.unknownUser, "did:privy:nobody");
    const noToken = await forget(F.unknownUser, null);

    expect(unknownUser.statusCode).toBe(403);
    expect(unknownUser.json().error).toBe("not-holder");
    expect(noToken.statusCode).toBe(401);
    expect(noToken.headers["cache-control"]).toBe("no-store");
    expect(held(F.unknownUser)).toHaveLength(1);
  });

  it("B9: deletes nothing and answers 503 when the listing could not finish", async () => {
    pinata.listFails.add(nameOf(F.listFails));
    const mark = calls.length;
    const response = await forget(F.listFails, "did:privy:holder");

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "lookup-unavailable", passportId: F.listFails });
    expect(callsSince(mark, "delete")).toHaveLength(0);
    expect(held(F.listFails)).toHaveLength(1);
  });

  it("B9: deletes both files when two share the name, and leaves a file whose name only starts the same", async () => {
    const response = await forget(F.two, "did:privy:holder");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ passportId: F.two, deleted: 2 });
    expect(held(F.two)).toHaveLength(0);
    expect(account.some((file) => file.name === `${nameOf(F.two)}.old`)).toBe(true);
  });

  it("answers 404 for a passport the chain does not hold, and 404 nothing-kept when no private re-check was asked", async () => {
    const missing = await forget(F.unregistered, "did:privy:holder");
    const plain = await forget(F.plain, "did:privy:holder");

    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe("no-passport");
    expect(plain.statusCode).toBe(404);
    expect(plain.json()).toEqual({ error: "nothing-kept", passportId: F.plain });
    expect(plain.headers["cache-control"]).toBe("no-store");
  });

  it("answers 502 delete-failed with the count when Pinata refuses a delete, so the holder knows to try again", async () => {
    const file = held(F.partial)[0] as Kept;
    pinata.deleteFails.add(file.id);

    const response = await forget(F.partial, "did:privy:holder");

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "delete-failed", passportId: F.partial, deleted: 0 });
    expect(response.body).not.toContain(file.id);
    expect((await status(F.partial)).json().state).toBe("kept");
  });

  it("logs the use with the count and no file id", async () => {
    const id = idOf(0x38);
    register(id, sealedDocument(id));
    const file = keep(nameOf(id));
    const logged = await build({ logger: true });
    try {
      const { result, logged: text } = await captureLog(async () => await forget(id, "did:privy:holder", logged));

      expect(result.statusCode).toBe(200);
      const line = text.split("\n").find((one) => one.includes("sealed: private copy forgotten")) ?? "";
      expect(JSON.parse(line)).toMatchObject({ passportId: id, deleted: 1 });
      expect(text).not.toContain(file.id);
      expect(text).not.toContain(file.cid);
    } finally {
      await logged.close();
    }
  });
});

describe("POST /recheck/request for a privately re-checkable passport (B11)", () => {
  beforeAll(() => {
    register(Q.kept, sealedDocument(Q.kept));
    keep(nameOf(Q.kept));
    register(Q.gone, sealedDocument(Q.gone));
    register(Q.plain, sealedDocument(Q.plain, false));
    register(Q.unknown, sealedDocument(Q.unknown));
    keep(nameOf(Q.unknown));
  });

  async function request(id: Hex, ip: string): Promise<LightMyRequestResponse> {
    return await app.inject({ method: "POST", url: "/recheck/request", payload: { passportId: id }, remoteAddress: ip });
  }

  it("B11: queues a passport whose private copy reads kept", async () => {
    const mark = calls.length;
    const response = await request(Q.kept, "198.51.100.110");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ passportId: Q.kept, status: "pending", already: false });
    expect(callsSince(mark, "list").map((call) => call.name)).toEqual([nameOf(Q.kept)]);
  });

  it("B11: refuses a passport whose copy is gone with exactly the 409 a plain sealed passport gets", async () => {
    const gone = await request(Q.gone, "198.51.100.111");
    const plain = await request(Q.plain, "198.51.100.112");

    expect(gone.statusCode).toBe(409);
    expect(plain.statusCode).toBe(409);
    expect(gone.json()).toMatchObject({ error: "sealed", passportId: Q.gone });
    expect({ ...gone.json(), passportId: "x" }).toEqual({ ...plain.json(), passportId: "x" });
    const after = await app.inject({ method: "GET", url: `/recheck/status/${Q.gone}` });
    expect(after.json().status).toBe("none");
  });

  it("B11: queues a passport whose copy cannot be told, and leaves the runner to check before it spends", async () => {
    pinata.listFails.add(nameOf(Q.unknown));
    const response = await request(Q.unknown, "198.51.100.113");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ passportId: Q.unknown, status: "pending" });
  });

  it("B11: refuses a passport once its holder has deleted the copy, without waiting out the status minute", async () => {
    const id = Q.kept;
    expect((await status(id)).json().state).toBe("kept");

    expect((await forget(id, "did:privy:holder")).json()).toEqual({ passportId: id, deleted: 1 });
    const again = await request(id, "198.51.100.114");

    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: "sealed", passportId: id });
  });
});
