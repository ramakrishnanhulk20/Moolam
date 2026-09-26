// Attack pass 4, the route half: the private re-check (a sealed picture's small private copy, read
// by the confidential workflow under a queue claim) attacked on purpose, against section C of
// the private re-check's threat model in docs/security/threat-model.md (B1 to B16, D3 and D5).
// Every attack runs through the real routes, the real Pinata client, the real queue and the real
// sweep. Pinata is a recording stub at the fetch layer, Privy tokens are signed by a key made in
// this file, the chain and gateway reads are stubbed, and the claim window and the sweep's clock are
// moved with fake timers. Each attack pushes one line saying what it found and what it did not
// cover, and the lines are printed together at the end so the run can be saved as the proof.
// Does NOT cover the runner or the sealed workflow's own code (B5's workflow half, B6, B7's
// workflow copy, B11's runner half, B12, B13), the live receiver pin (the live half,
// packages/agents/scripts/attack-pass-4.ts, reads it), or a real Pinata, Privy, chain or gateway call.

import fs from "node:fs";
import { SignJWT, generateKeyPair } from "jose";
import sharp from "sharp";
import { getAddress, type Hex } from "viem";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { QueueStore, RecheckItem } from "../src/recheck/queue.js";

const APP_ID = vi.hoisted(() => {
  const id = "moolamtestapp0000014";
  process.env.PRIVY_APP_ID = id;
  process.env.PINATA_JWT = "test-token-not-a-real-pinata-jwt";
  process.env.PINATA_GATEWAY_URL = "https://moolam-test.mypinata.cloud/ipfs/";
  process.env.X402_ENABLED = "false";
  process.env.GENERATOR_WALLET_ID = "";
  process.env.EXPECT_ROUTES = "";
  process.env.RUNNER_TOKEN = "";
  process.env.SEALED_LINK_TOKEN = "";
  process.env.GLOBAL_PREPARES_PER_DAY = "300";
  process.env.GLOBAL_LINKS_PER_DAY = "100";
  return id;
});

const stubs = vi.hoisted(() => ({
  readPassport: vi.fn(),
  holderOf: vi.fn(),
  readMetadataDocument: vi.fn(),
  embeddedWallets: vi.fn(),
  passportExists: vi.fn(),
}));

vi.mock("../src/unseal.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/unseal.js")>()),
  readPassport: stubs.readPassport,
  holderOf: stubs.holderOf,
  readMetadataDocument: stubs.readMetadataDocument,
}));

vi.mock("../src/edit/registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/edit/registry.js")>()),
  passportExists: stubs.passportExists,
}));

vi.mock("../src/auth/wallet.js", () => ({ embeddedWallets: stubs.embeddedWallets }));

vi.mock("../src/generate/privy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/generate/privy.js")>()),
  privy: () => ({}),
}));

const { buildServer } = await import("../src/server.js");
const { contentIdOf } = await import("../src/ipfs/pinata.js");
const { sealedMetadata, sealedMetadataSchema, privatelyRecheckable } = await import("../src/sealed.js");
const { privateSweep } = await import("../src/sweep.js");
const { env } = await import("../src/env.js");
const { makeImage } = await import("./helpers.js");
const { THUMBNAIL_MAX_BYTES, PRIVATE_RECHECK_THUMBNAIL_TOO_LARGE_REASON } = await import("../src/prepare.js");

const UPLOAD_URL = "https://uploads.pinata.cloud/v3/files";
const PRIVATE_FILES_URL = "https://api.pinata.cloud/v3/files/private";
const LINK_URL = `${PRIVATE_FILES_URL}/download_link`;
const GATEWAY_HOST = "moolam-test.mypinata.cloud";
const SIGNATURE = "YXR0YWNrLXBhc3MtZm91ci1zaWduYXR1cmU";
const UPLOADED_ID = "0199a3c2-5d7e-7f10-9a1b-0000000a7714";
const UPLOADED_CID = "bafkreiuploadedprivatecopy00000000000000000000000000000000";
const HOLDER = getAddress("0x85a88ca81ff5f681d96ab86fa60ccb8452a139a6");
const STRANGER = getAddress("0x1111111111111111111111111111111111111111");
const LINK_TOKEN = "moolam-sealed-link-token-for-attack-four-01";
const WRONG_TOKEN = "moolam-sealed-link-token-for-attack-four-99";
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const STARTED = Date.now();

/** A passport id built from one repeated byte, lower case, as the edge makes every id. */
function idOf(byte: number): Hex {
  return `0x${byte.toString(16).padStart(2, "0").repeat(32)}` as Hex;
}

function nameOf(id: Hex): string {
  return `sealed-thumb-${id}.jpg`;
}

function short(id: string): string {
  return `${id.slice(0, 12)}...`;
}

/** What the chain holds: passport id to metadataURI. An id missing here is not registered. */
const chain = new Map<Hex, string>();
/** What the gateway serves: metadataURI to document. */
const documents = new Map<string, unknown>();

/** A sealed document as /prepare writes it, committing to `commitTo` and asking for a private re-check unless told otherwise. */
function sealedDocument(commitTo: Hex, privateRecheck = true): Record<string, unknown> {
  return sealedMetadata({
    title: "Harbour kept private",
    description: "A picture registered with Moolam and kept sealed.",
    passportId: commitTo,
    fingerprint: {
      sha256: commitTo,
      phash: 7840506850305415717n,
      blockhash: `0x${"11".repeat(32)}` as Hex,
      width: 640,
      height: 480,
      format: "jpeg",
    },
    privateRecheck: privateRecheck ? true : undefined,
    createdAt: new Date("2026-09-25T08:00:00Z"),
  }) as Record<string, unknown>;
}

function register(id: Hex, document: unknown): void {
  chain.set(id, `ipfs://doc-${id}`);
  documents.set(`ipfs://doc-${id}`, document);
}

/** One private file on the stub Pinata account. */
interface Kept {
  id: string;
  name: string;
  cid: string;
  createdAt: string;
}

const account: Kept[] = [];
let fileCounter = 0;

function keep(name: string, createdAt = "2026-09-25T08:00:00Z"): Kept {
  fileCounter += 1;
  const file = {
    id: `0199a3c2-5d7e-7f10-9a1b-${fileCounter.toString(16).padStart(12, "0")}`,
    name,
    cid: `bafkreiprivate${fileCounter.toString().padStart(30, "0")}`,
    createdAt,
  };
  account.push(file);
  return file;
}

function held(name: string): Kept[] {
  return account.filter((file) => file.name === name);
}

/** One request the stub Pinata saw. */
interface Call {
  kind: "list" | "link" | "delete" | "private-upload" | "public-upload";
  url: string;
  name?: string;
  type?: string;
  bytes?: Buffer;
  body?: Record<string, unknown>;
}

const calls: Call[] = [];
const pinata = {
  /** Names whose listing answers 500. */
  listFails: new Set<string>(),
  /** Replaces the signed link answer when set. */
  linkAnswer: undefined as undefined | ((cid: string) => Response),
  /** How a private upload is answered: kept private, or Pinata's de-duplicated public file (B16). */
  privateAnswer: "private" as "private" | "duplicate-public",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function signedLink(cid: string): string {
  return `https://${GATEWAY_HOST}/files/${cid}?X-Algorithm=PINATA1&X-Date=1790300000&X-Expires=120&X-Method=GET&X-Signature=${SIGNATURE}`;
}

/**
 * Pinata at the fetch layer. The listing answers every file whose name starts with the filter, a
 * looser rule than any real filter could be, so the exact-name checks in our code are what is
 * attacked. Anything else that tries to leave the process fails the test.
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
        .map((file) => ({ id: file.id, name: file.name, cid: file.cid, created_at: file.createdAt }));
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
      const at = account.findIndex((file) => file.id === fileId);
      if (at !== -1) {
        account.splice(at, 1);
      }
      return json({ data: null });
    }
    if (url === UPLOAD_URL && method === "POST") {
      const form = init?.body as FormData;
      const file = form.get("file") as File;
      const bytes = Buffer.from(await file.arrayBuffer());
      const name = String(form.get("name"));
      if (form.get("network") === "private") {
        calls.push({ kind: "private-upload", url, name, type: file.type, bytes });
        return pinata.privateAnswer === "duplicate-public"
          ? json({ data: { id: UPLOADED_ID, name: "harbour-thumb.jpg", cid: "bafkreipublic", network: "public", is_duplicate: true } })
          : json({ data: { id: UPLOADED_ID, name, cid: UPLOADED_CID, network: "private", is_duplicate: false } });
      }
      calls.push({ kind: "public-upload", url, name, type: file.type, bytes });
      return json({ data: { cid: contentIdOf(bytes), size: bytes.length, network: "public" } });
    }
    throw new Error("this test makes no live call");
  });
}

function callsSince(mark: number, kind?: Call["kind"]): Call[] {
  return calls.slice(mark).filter((call) => kind === undefined || call.kind === kind);
}

function counted(mark: number): string {
  const made = callsSince(mark);
  if (made.length === 0) return "0 Pinata calls";
  const kinds = new Map<string, number>();
  for (const call of made) kinds.set(call.kind, (kinds.get(call.kind) ?? 0) + 1);
  return [...kinds].map(([kind, n]) => `${n} ${kind}`).join(", ");
}

function storeOf(items: RecheckItem[]): QueueStore {
  let queue = items;
  return { read: () => ({ items: queue }), write: (next) => (queue = [...next]) };
}

function running(id: Hex, minutesAgo: number): RecheckItem {
  return {
    passportId: id,
    status: "running",
    requestedAt: STARTED - (minutesAgo + 1) * MINUTE,
    requestedBy: "public",
    startedAt: STARTED - minutesAgo * MINUTE,
  };
}

function pending(id: Hex): RecheckItem {
  return { passportId: id, status: "pending", requestedAt: STARTED - MINUTE, requestedBy: "public" };
}

interface Line {
  n: string;
  what: string;
  verdict: string;
  notCovered: string;
  detail: string[];
}

const lines: Line[] = [];

function record(line: Line): void {
  lines.push(line);
}

/** A refusal carries no URL, no signature and nothing of the file: not its id and not its content id. */
function expectNothingOfTheFile(response: LightMyRequestResponse): void {
  expect(response.body).not.toContain("https://");
  expect(response.body).not.toContain(SIGNATURE);
  expect(response.body).not.toContain("bafkreiprivate");
  expect(response.body).not.toContain("0199a3c2");
  expect(response.json().url).toBeUndefined();
}

function answer(response: LightMyRequestResponse): string {
  return `${response.statusCode} ${response.body}`;
}

/** Everything this service writes to the console while `work` runs, by every road pino may use. */
async function captureLog<T>(work: () => Promise<T>): Promise<{ result: T; logged: string }> {
  const captured: string[] = [];
  const keepChunk = (chunk: unknown): void => {
    if (typeof chunk === "string") captured.push(chunk);
    else if (chunk instanceof Uint8Array) captured.push(Buffer.from(chunk).toString("utf8"));
  };
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    keepChunk(chunk);
    return true;
  });
  const patched = fs as unknown as Record<string, unknown>;
  const realWrite = fs.write;
  const realWriteSync = fs.writeSync;
  patched.write = (...args: unknown[]): unknown => {
    if (args[0] === 1) {
      keepChunk(args[1]);
      const done = args.find((arg) => typeof arg === "function") as ((...rest: unknown[]) => void) | undefined;
      done?.(null, typeof args[1] === "string" ? Buffer.byteLength(args[1]) : (args[1] as Uint8Array).length);
      return undefined;
    }
    return (realWrite as unknown as (...rest: unknown[]) => unknown)(...args);
  };
  patched.writeSync = (...args: unknown[]): unknown => {
    if (args[0] === 1) {
      keepChunk(args[1]);
      return typeof args[1] === "string" ? Buffer.byteLength(args[1]) : (args[1] as Uint8Array).length;
    }
    return (realWriteSync as unknown as (...rest: unknown[]) => unknown)(...args);
  };
  try {
    const result = await work();
    await new Promise((resolve) => setTimeout(resolve, 150));
    return { result, logged: captured.join("") };
  } finally {
    patched.write = realWrite;
    patched.writeSync = realWriteSync;
    stdout.mockRestore();
  }
}

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

async function build(
  items: RecheckItem[],
  extra: Parameters<typeof buildServer>[0] = {},
): Promise<FastifyInstance> {
  const server = await buildServer({
    source: { load: async () => [] },
    logger: false,
    recheck: {
      readDocument: async (uri: string) => await stubs.readMetadataDocument(uri),
      findRecord: async () => undefined,
      store: storeOf(items.map((item) => ({ ...item }))),
    },
    sealed: { linkToken: LINK_TOKEN, keys: verifying },
    prepare: { keys: verifying },
    ...extra,
  });
  await server.ready();
  return server;
}

async function link(
  on: FastifyInstance,
  passportId: unknown,
  options: { token?: string | null; ip?: string } = {},
): Promise<LightMyRequestResponse> {
  const token = options.token === undefined ? LINK_TOKEN : options.token;
  return await on.inject({
    method: "POST",
    url: "/sealed/link",
    payload: { passportId },
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    remoteAddress: options.ip ?? "198.51.100.40",
  });
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
    const metadataURI = chain.get(id);
    return metadataURI === undefined
      ? undefined
      : { registeredAt: 1_790_000_000, phash: 1n, blockhash256: `0x${"11".repeat(32)}`, fingerprintVersion: 1, metadataURI };
  });
  stubs.readMetadataDocument.mockImplementation(async (uri: string) => {
    if (!documents.has(uri)) {
      throw new Error("the gateway answered 504 for this passport's metadata");
    }
    return documents.get(uri);
  });
  stubs.passportExists.mockResolvedValue(false);
  stubPinata();
});

afterEach(() => {
  pinata.listFails.clear();
  pinata.linkAnswer = undefined;
  pinata.privateAnswer = "private";
  stubs.passportExists.mockReset();
  stubs.passportExists.mockResolvedValue(false);
  vi.useRealTimers();
});

afterAll(() => {
  vi.unstubAllGlobals();

  const say = (text = ""): void => {
    console.log(text);
  };
  say("Moolam attack pass 4, the route half: the private re-check, executed with vitest.");
  say(`date        ${new Date().toISOString()}`);
  say("pinata      a recording stub at the fetch layer; tokens signed by a key made in this file; chain and gateway reads stubbed; clocks moved with fake timers");
  say();
  for (const line of lines) {
    say(`  ${line.n.padEnd(4)}${line.what}`);
    say(`      ${line.verdict}; not covered: ${line.notCovered}`);
    for (const detail of line.detail) {
      say(`        ${detail}`);
    }
  }
});

/** The passports attack 1 uses, each set up for the one check it attacks. */
const A = {
  ok: idOf(0x20),
  pending: idOf(0x21),
  late: idOf(0x22),
  unclaimed: idOf(0x23),
  plain: idOf(0x24),
  imageKey: idOf(0x25),
  other: idOf(0x26),
  victim: idOf(0x27),
  lookalike: idOf(0x28),
  two: idOf(0x29),
  foreign: idOf(0x2a),
  capped: idOf(0x2b),
  kill: idOf(0x2c),
};

describe("attack 1: the link (B1, B3, B4, B5, B15, D3)", () => {
  let linkApp: FastifyInstance;
  /** Everything the logged servers wrote, across every attack below, for the scan in 1m. */
  let logText = "";
  /** Every link any server minted in this file, for the scan in 1m. */
  const minted: string[] = [];

  async function logged<T>(work: () => Promise<T>): Promise<T> {
    const { result, logged: text } = await captureLog(work);
    logText += text;
    return result;
  }

  beforeAll(async () => {
    for (const id of [A.ok, A.pending, A.late, A.unclaimed, A.foreign, A.capped, A.kill, A.victim]) {
      register(id, sealedDocument(id));
      keep(nameOf(id));
    }
    register(A.plain, sealedDocument(A.plain, false));
    keep(nameOf(A.plain));
    register(A.imageKey, { ...sealedDocument(A.imageKey), image: "ipfs://bafkreiattackerimage" });
    keep(nameOf(A.imageKey));
    register(A.other, sealedDocument(A.victim));
    register(A.lookalike, sealedDocument(A.lookalike));
    keep(`${nameOf(A.lookalike)}.old`);
    register(A.two, sealedDocument(A.two));
    keep(nameOf(A.two));
    keep(nameOf(A.two));

    linkApp = await build(
      [
        running(A.ok, 1),
        pending(A.pending),
        running(A.plain, 1),
        running(A.imageKey, 1),
        running(A.other, 1),
        running(A.lookalike, 1),
        running(A.two, 1),
        running(A.foreign, 1),
        running(A.capped, 1),
      ],
      { logger: true },
    );
  });

  afterAll(async () => {
    await linkApp.close();
  });

  it("1a refuses a request with no token before reading anything", async () => {
    stubs.readPassport.mockClear();
    const mark = calls.length;
    const response = await logged(async () => await link(linkApp, A.ok, { token: null, ip: "198.51.100.1" }));

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "unauthorized" });
    expectNothingOfTheFile(response);
    expect(stubs.readPassport).not.toHaveBeenCalled();
    expect(callsSince(mark)).toHaveLength(0);
    record({
      n: "1a",
      what: "POST /sealed/link with no token, for a passport that is claimed and kept",
      verdict: `REFUSED, ${answer(response)}, 0 chain reads, ${counted(mark)}, no URL`,
      notCovered: "a stolen real token, which the claim window (1c to 1e) and the caps (1k, 1l) bound",
      detail: [],
    });
  });

  it("1b refuses a wrong token of the right length, compared in constant time", async () => {
    stubs.readPassport.mockClear();
    expect(WRONG_TOKEN.length).toBe(LINK_TOKEN.length);
    const mark = calls.length;
    const response = await logged(async () => await link(linkApp, A.ok, { token: WRONG_TOKEN, ip: "198.51.100.2" }));

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "unauthorized" });
    expectNothingOfTheFile(response);
    expect(stubs.readPassport).not.toHaveBeenCalled();
    expect(callsSince(mark)).toHaveLength(0);
    record({
      n: "1b",
      what: `POST /sealed/link with a wrong token of the right length (${WRONG_TOKEN.length} characters, last two differ)`,
      verdict: `REFUSED, ${answer(response)}, 0 chain reads, ${counted(mark)}, no URL`,
      notCovered: "a timing measurement of the comparison, which is sameToken's timingSafeEqual and is not timed here",
      detail: [],
    });
  });

  it("1c refuses the right token for a passport whose request is queued but not claimed", async () => {
    const mark = calls.length;
    const response = await logged(async () => await link(linkApp, A.pending, { ip: "198.51.100.3" }));

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "not-claimed", passportId: A.pending });
    expectNothingOfTheFile(response);
    expect(callsSince(mark)).toHaveLength(0);
    record({
      n: "1c",
      what: "POST /sealed/link with the right token, the passport kept and asked for, its request pending and never claimed",
      verdict: `REFUSED, ${answer(response)}, ${counted(mark)}, no URL`,
      notCovered: "a runner that claims a passport it was not asked to run, which the runner's token (RUNNER_TOKEN) guards and is out of this file",
      detail: [],
    });
  });

  it("1d refuses a claim 11 minutes old, after minting for the same claim at 9 minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const claimedAt = Date.parse("2026-09-25T09:00:00Z");
    vi.setSystemTime(claimedAt);
    const late = await build([pending(A.late)], { logger: true });
    try {
      const claim = late.recheck.claim(A.late);
      expect(claim.ok).toBe(true);

      vi.setSystemTime(claimedAt + 9 * MINUTE);
      const nine = await logged(async () => await link(late, A.late, { ip: "198.51.100.4" }));
      expect(nine.statusCode).toBe(200);
      minted.push(nine.json().url as string);

      vi.setSystemTime(claimedAt + 11 * MINUTE);
      const mark = calls.length;
      const eleven = await logged(async () => await link(late, A.late, { ip: "198.51.100.5" }));

      expect(eleven.statusCode).toBe(409);
      expect(eleven.json()).toEqual({ error: "not-claimed", passportId: A.late });
      expectNothingOfTheFile(eleven);
      expect(callsSince(mark)).toHaveLength(0);
      record({
        n: "1d",
        what: "POST /sealed/link with the right token for a claim the queue stamped 11 minutes ago (fake clock)",
        verdict: `REFUSED, ${answer(eleven)}, ${counted(mark)}, no URL; the same claim at 9 minutes minted (200), so the window is what refused`,
        notCovered: "a host clock that jumps back, which claimedWithin refuses as a future claim and is not moved here",
        detail: [`claimed at ${new Date(claimedAt).toISOString()}, asked at +9 min (200) and +11 min (409)`],
      });
    } finally {
      vi.useRealTimers();
      await late.close();
    }
  });

  it("1e refuses the right token for a passport while the live claim is on another passport", async () => {
    const mark = calls.length;
    const response = await logged(async () => await link(linkApp, A.unclaimed, { ip: "198.51.100.6" }));

    expect(linkApp.recheck.claimedWithin(A.ok, 10 * MINUTE)).toBe(true);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "not-claimed", passportId: A.unclaimed });
    expectNothingOfTheFile(response);
    expect(callsSince(mark)).toHaveLength(0);
    record({
      n: "1e",
      what: `POST /sealed/link for ${short(A.unclaimed)} (kept, asked for) while the runner's claim is on ${short(A.ok)}`,
      verdict: `REFUSED, ${answer(response)}, ${counted(mark)}, no URL: a claim opens its own passport only`,
      notCovered: "the passport under claim itself, which a stolen token can read for up to ten minutes and five links (1k), by design",
      detail: [],
    });
  });

  it("1f refuses a passport whose document is not privately re-checkable, a kept file under its name or not", async () => {
    const mark = calls.length;
    const plain = await logged(async () => await link(linkApp, A.plain, { ip: "198.51.100.7" }));
    const imageKey = await logged(async () => await link(linkApp, A.imageKey, { ip: "198.51.100.8" }));

    for (const [response, id] of [
      [plain, A.plain],
      [imageKey, A.imageKey],
    ] as const) {
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "nothing-kept", passportId: id });
      expectNothingOfTheFile(response);
    }
    expect(callsSince(mark)).toHaveLength(0);
    record({
      n: "1f",
      what: "POST /sealed/link, claimed, for a plain sealed document and for one that asks but also carries an image key, each with a file under its name",
      verdict: `REFUSED, both 404 nothing-kept, ${counted(mark)}, no URL: the document predicate (B7) decides before Pinata is asked`,
      notCovered: "the workflow's own copy of the predicate, which is packages/workflow's and is run against the shared fixtures there",
      detail: [`plain sealed      ${answer(plain)}`, `asks + image key  ${answer(imageKey)}`],
    });
  });

  it("1g refuses a document whose commitment names another passport, and never lists that passport's file", async () => {
    const mark = calls.length;
    const response = await logged(async () => await link(linkApp, A.other, { ip: "198.51.100.9" }));

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "commitment-mismatch", passportId: A.other });
    expectNothingOfTheFile(response);
    expect(callsSince(mark)).toHaveLength(0);
    expect(held(nameOf(A.victim))).toHaveLength(1);
    record({
      n: "1g",
      what: `POST /sealed/link, claimed, for ${short(A.other)} whose document's commitment.value is ${short(A.victim)} (a kept passport)`,
      verdict: `REFUSED, ${answer(response)}, ${counted(mark)}: the victim's name was never listed, no URL`,
      notCovered: "a registry that let one metadataURI serve two ids, which the registry's own exactHash check forbids and is not attacked here",
      detail: [],
    });
  });

  it("1h refuses a passport whose only private file is its name with a suffix", async () => {
    const mark = calls.length;
    const response = await logged(async () => await link(linkApp, A.lookalike, { ip: "198.51.100.10" }));

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "gone", passportId: A.lookalike });
    expectNothingOfTheFile(response);
    expect(callsSince(mark, "list")).toHaveLength(1);
    expect(callsSince(mark, "link")).toHaveLength(0);
    record({
      n: "1h",
      what: `POST /sealed/link, claimed, the only file ${nameOf(A.lookalike).slice(0, 24)}...jpg.old, listed by a stub that matches on prefix`,
      verdict: `REFUSED, ${answer(response)}, ${counted(mark)}, no link asked of Pinata: the whole name must be equal`,
      notCovered: "Pinata's real name filter, whose matching rule is undocumented; our equality check runs whatever it answers",
      detail: [],
    });
  });

  it("1i refuses two files under the exact name, minting nothing", async () => {
    const mark = calls.length;
    const response = await logged(async () => await link(linkApp, A.two, { ip: "198.51.100.11" }));

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "ambiguous", passportId: A.two });
    expectNothingOfTheFile(response);
    expect(callsSince(mark, "link")).toHaveLength(0);
    record({
      n: "1i",
      what: "POST /sealed/link, claimed, two private files under the exact name",
      verdict: `REFUSED, ${answer(response)}, ${counted(mark)}, no link asked of Pinata, no URL`,
      notCovered: "which of the two is the true thumbnail, which the service does not guess; the holder's delete (3c) removes both",
      detail: [],
    });
  });

  it("1j refuses a link Pinata answers on another host, with no URL and no host in the answer", async () => {
    pinata.linkAnswer = (cid) =>
      json({ data: `https://evil.example/files/${cid}?X-Algorithm=PINATA1&X-Signature=${SIGNATURE}` });
    const mark = calls.length;
    const response = await logged(async () => await link(linkApp, A.foreign, { ip: "198.51.100.12" }));

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "link-unavailable", passportId: A.foreign });
    expectNothingOfTheFile(response);
    expect(response.body).not.toContain("evil.example");
    expect(callsSince(mark, "link")).toHaveLength(1);
    record({
      n: "1j",
      what: "POST /sealed/link, claimed and kept, Pinata answering a signed link on https://evil.example",
      verdict: `REFUSED, ${answer(response)}, ${counted(mark)}, no URL and no host in the answer`,
      notCovered: "a link on the right host that Pinata signed for another file, which privateDownloadLink refuses on its path check and test/pinata.test.ts covers",
      detail: [],
    });
  });

  it("1k gives one passport five links in an hour and refuses the sixth", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const response = await logged(async () => await link(linkApp, A.capped, { ip: `198.51.100.${20 + i}` }));
      codes.push(response.statusCode);
      if (response.statusCode === 200) minted.push(response.json().url as string);
    }
    const mark = calls.length;
    const sixth = await logged(async () => await link(linkApp, A.capped, { ip: "198.51.100.30" }));

    expect(codes).toEqual([200, 200, 200, 200, 200]);
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json()).toEqual({ error: "link-cap", passportId: A.capped });
    expectNothingOfTheFile(sixth);
    expect(callsSince(mark, "link")).toHaveLength(0);
    record({
      n: "1k",
      what: "POST /sealed/link six times in an hour for one claimed, kept passport, each from a different address",
      verdict: `REFUSED on the sixth, ${answer(sixth)}, no link asked of Pinata; the first five answered ${codes.join(", ")}`,
      notCovered: "the cap surviving a redeploy, which it does not: it is held in memory and resets with the process",
      detail: [],
    });
  });

  it("1l refuses every link while GLOBAL_LINKS_PER_DAY is 0, the kill switch", async () => {
    const ceiling = env.GLOBAL_LINKS_PER_DAY;
    env.GLOBAL_LINKS_PER_DAY = 0;
    let off: FastifyInstance | undefined;
    try {
      off = await build([running(A.kill, 1)], { logger: true });
      const mark = calls.length;
      const response = await logged(async () => await link(off as FastifyInstance, A.kill, { ip: "198.51.100.31" }));

      expect(response.statusCode).toBe(429);
      expect(response.json().error).toBe("global-limit");
      expectNothingOfTheFile(response);
      expect(callsSince(mark, "link")).toHaveLength(0);
      record({
        n: "1l",
        what: "POST /sealed/link, claimed and kept, on a host started with GLOBAL_LINKS_PER_DAY=0",
        verdict: `REFUSED, ${response.statusCode} ${response.json().error as string}, retry-after ${String(response.headers["retry-after"])}, no link asked of Pinata, no URL`,
        notCovered: "Railway's variable itself, which the live /health shows and the live half does not read",
        detail: [],
      });
    } finally {
      env.GLOBAL_LINKS_PER_DAY = ceiling;
      await off?.close();
    }
  });

  it("1m no log line from any attack above carries a link, its signature or the token", () => {
    expect(minted.length).toBe(6);
    expect(logText).toContain("sealed: private link minted");
    expect(logText).toContain("rejected: /sealed/link");
    const secrets = [LINK_TOKEN, WRONG_TOKEN, SIGNATURE, "X-Signature", "download_link", "evil.example", ...minted];
    const found = secrets.filter((secret) => logText.includes(secret));
    expect(found).toEqual([]);
    record({
      n: "1m",
      what: "the whole log the servers in 1a to 1l wrote, scanned for every minted link, the signature, both tokens, X-Signature, download_link and evil.example",
      verdict: `PASS, ${logText.length} characters over ${logText.split("\n").length - 1} lines, ${minted.length} minted links, 0 of ${secrets.length} secrets found`,
      notCovered: "Railway's own request log and the runner's captured workflow output, which are outside this process",
      detail: [],
    });
  });
});

async function status(on: FastifyInstance, id: string, ip: string): Promise<LightMyRequestResponse> {
  return await on.inject({ method: "GET", url: `/sealed/status/${id}`, remoteAddress: ip });
}

describe("attack 2: the status (B10)", () => {
  const S = { fails: idOf(0x40), never: idOf(0x41) };
  let app: FastifyInstance;

  beforeAll(async () => {
    register(S.fails, sealedDocument(S.fails));
    keep(nameOf(S.fails));
    register(S.never, sealedDocument(S.never, false));
    keep(nameOf(S.never));
    app = await build([]);
  });

  afterAll(async () => {
    await app.close();
  });

  it("2a reads unknown, never kept or gone, while Pinata fails, and remembers nothing", async () => {
    pinata.listFails.add(nameOf(S.fails));
    const mark = calls.length;
    const first = await status(app, S.fails, "198.51.100.50");
    const second = await status(app, S.fails, "198.51.100.50");

    for (const response of [first, second]) {
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ passportId: S.fails, state: "unknown", privateRecheck: true });
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    expect(callsSince(mark, "list")).toHaveLength(2);
    expect(held(nameOf(S.fails))).toHaveLength(1);
    record({
      n: "2a",
      what: "GET /sealed/status twice for a kept passport while Pinata's listing answers 500",
      verdict: `PASS, both ${answer(first)}, cache-control ${String(first.headers["cache-control"])}, ${counted(mark)}: asked again, not held, never kept or gone`,
      notCovered: "the web's copy of the three words, which is the studio's and is not rendered here",
      detail: [],
    });
  });

  it("2b reads gone for a document that never asked, with no Pinata call, even with a file under its name", async () => {
    const mark = calls.length;
    const response = await status(app, S.never, "198.51.100.51");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ passportId: S.never, state: "gone", privateRecheck: false });
    expect(callsSince(mark)).toHaveLength(0);
    record({
      n: "2b",
      what: "GET /sealed/status for a plain sealed passport whose document never asked, a stray file sitting under its name",
      verdict: `PASS, ${answer(response)}, ${counted(mark)}: a stranger cannot spend the Pinata minute through a passport that never asked`,
      notCovered: "a stranger spending it through passports that did ask, which the 30 a minute limit and the one minute memory bound (test/sealed-routes.test.ts)",
      detail: [],
    });
  });
});

async function forget(on: FastifyInstance, passportId: Hex, subject: string): Promise<LightMyRequestResponse> {
  return await on.inject({
    method: "POST",
    url: "/sealed/forget",
    payload: { passportId },
    headers: { authorization: `Bearer ${await privyToken(subject)}` },
    remoteAddress: "198.51.100.60",
  });
}

describe("attack 3: the delete (B9)", () => {
  const F = { stranger: idOf(0x50), lookupFails: idOf(0x51), two: idOf(0x52) };
  let app: FastifyInstance;

  beforeAll(async () => {
    for (const id of [F.stranger, F.lookupFails]) {
      register(id, sealedDocument(id));
      keep(nameOf(id));
    }
    register(F.two, sealedDocument(F.two));
    keep(nameOf(F.two));
    keep(nameOf(F.two));
    keep(`${nameOf(F.two)}.old`);
    app = await build([]);
  });

  afterAll(async () => {
    await app.close();
  });

  it("3a refuses a stranger's valid Privy token and deletes nothing", async () => {
    const mark = calls.length;
    const response = await forget(app, F.stranger, "did:privy:stranger");

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "not-holder", passportId: F.stranger });
    expect(callsSince(mark)).toHaveLength(0);
    expect(held(nameOf(F.stranger))).toHaveLength(1);
    record({
      n: "3a",
      what: "POST /sealed/forget with a valid Privy token whose wallets do not include ownerOf",
      verdict: `REFUSED, ${answer(response)}, ${counted(mark)}, the file still kept`,
      notCovered: "Privy's own mapping from a user to their wallets, which is stubbed here and read live in production",
      detail: [`caller wallets [${STRANGER}], ownerOf ${HOLDER}`],
    });
  });

  it("3b deletes nothing for the holder when the lookup fails", async () => {
    pinata.listFails.add(nameOf(F.lookupFails));
    const mark = calls.length;
    const response = await forget(app, F.lookupFails, "did:privy:holder");

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "lookup-unavailable", passportId: F.lookupFails });
    expect(callsSince(mark, "delete")).toHaveLength(0);
    expect(held(nameOf(F.lookupFails))).toHaveLength(1);
    record({
      n: "3b",
      what: "POST /sealed/forget from the holder while Pinata's listing answers 500",
      verdict: `REFUSED, ${answer(response)}, ${counted(mark)}, 0 deletes, the file still kept: no deletion on an uncertain read`,
      notCovered: "a listing that answers 200 and silently omits a file, which only Pinata can do and no check here can see",
      detail: [],
    });
  });

  it("3c deletes both files under the exact name for the holder, and leaves the lookalike", async () => {
    const mark = calls.length;
    const response = await forget(app, F.two, "did:privy:holder");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ passportId: F.two, deleted: 2 });
    expect(callsSince(mark, "delete")).toHaveLength(2);
    expect(held(nameOf(F.two))).toHaveLength(0);
    expect(held(`${nameOf(F.two)}.old`)).toHaveLength(1);
    expect(response.body).not.toContain("0199a3c2");
    record({
      n: "3c",
      what: "POST /sealed/forget from the holder, two files under the exact name and one with a .old suffix",
      verdict: `PASS, ${answer(response)}, ${counted(mark)}, no file id in the answer, the .old file untouched`,
      notCovered: "a file Pinata lists after the delete, which the next /sealed/status would read as kept again",
      detail: [],
    });
  });
});

describe("attack 4: the private copy at prepare (B2, B8, B14, B16)", () => {
  let app: FastifyInstance;
  let IMAGE: Buffer;
  let NOISE: Buffer;

  async function prepare(subject: string, fields: Record<string, string>, file?: Buffer): Promise<LightMyRequestResponse> {
    const boundary = "----moolamattack4";
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
        authorization: `Bearer ${await privyToken(subject)}`,
      },
      remoteAddress: "198.51.100.70",
    });
  }

  const privately = { title: "Harbour kept private", kind: "human", sealed: "true", privateRecheck: "true" };

  beforeAll(async () => {
    IMAGE = await makeImage(31);
    // Pure noise at full quality: the one kind of picture a 512 pixel JPEG cannot squeeze under 60 KB.
    const side = 512;
    const raw = Buffer.alloc(side * side * 3);
    let seed = 4242;
    for (let i = 0; i < raw.length; i += 1) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      raw[i] = (seed >> 16) & 0xff;
    }
    NOISE = await sharp(raw, { raw: { width: side, height: side, channels: 3 } }).jpeg({ quality: 100 }).toBuffer();
    app = await build([]);
  }, 60_000);

  afterAll(async () => {
    await app.close();
  });

  it("4a refuses privateRecheck without sealed before anything is made or pinned", async () => {
    stubs.passportExists.mockClear();
    const mark = calls.length;
    const bare = await prepare("did:privy:attack4-bare", { title: "Not sealed", kind: "human", privateRecheck: "true" });
    const unsealed = await prepare("did:privy:attack4-unsealed", {
      title: "Not sealed",
      kind: "human",
      sealed: "false",
      privateRecheck: "true",
    });

    for (const response of [bare, unsealed]) {
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "private-recheck-needs-sealed" });
    }
    expect(stubs.passportExists).not.toHaveBeenCalled();
    expect(callsSince(mark)).toHaveLength(0);
    record({
      n: "4a",
      what: "POST /prepare with privateRecheck=true and sealed left out, then with sealed=false",
      verdict: `REFUSED, both ${answer(bare)}, 0 chain reads, ${counted(mark)}`,
      notCovered: "/generate's copy of the same refusal, which test/private-copy.test.ts covers",
      detail: [],
    });
  }, 60_000);

  it("4b refuses the private copy when the duplicate check cannot reach the chain", async () => {
    stubs.passportExists.mockRejectedValue(new Error("the RPC timed out"));
    const mark = calls.length;
    const response = await prepare("did:privy:attack4-nochain", privately);

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "chain-unreachable" });
    expect(callsSince(mark)).toHaveLength(0);
    record({
      n: "4b",
      what: "POST /prepare sealed with privateRecheck while the registry read throws",
      verdict: `REFUSED, ${answer(response)}, ${counted(mark)}: no thumbnail kept under a name the chain could not vouch for`,
      notCovered: "an RPC that answers wrongly rather than failing, which the registry's own duplicate check catches at registration",
      detail: [],
    });
  }, 60_000);

  it("4c refuses the whole prepare when Pinata answers with the de-duplicated public file", async () => {
    pinata.privateAnswer = "duplicate-public";
    const mark = calls.length;
    const response = await prepare("did:privy:attack4-duplicate", privately);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "private-copy-not-private" });
    expect(callsSince(mark).map((call) => call.kind)).toEqual(["private-upload"]);
    record({
      n: "4c",
      what: "POST /prepare sealed with privateRecheck, Pinata answering is_duplicate true, network public, another name",
      verdict: `REFUSED, ${answer(response)}, ${counted(mark)}: no document pinned, nothing deleted (the id may be someone's public pin)`,
      notCovered: "Pinata's real de-duplication, which the live account gave once on 2026-09-18 and is fed here as that answer",
      detail: [],
    });
  }, 60_000);

  it("4d refuses a picture whose thumbnail cannot fit the fetch budget, uploading nothing", async () => {
    const mark = calls.length;
    const response = await prepare("did:privy:attack4-noise", { ...privately, title: "Static" }, NOISE);

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({
      error: "thumbnail-too-large",
      limit: THUMBNAIL_MAX_BYTES,
      reason: PRIVATE_RECHECK_THUMBNAIL_TOO_LARGE_REASON,
    });
    expect(callsSince(mark)).toHaveLength(0);
    record({
      n: "4d",
      what: `POST /prepare sealed with privateRecheck for ${NOISE.length} bytes of full-quality noise`,
      verdict: `REFUSED, 422 thumbnail-too-large, limit ${THUMBNAIL_MAX_BYTES}, the private re-check words, ${counted(mark)}`,
      notCovered: "the workflow's decoder on a thumbnail that does fit, which B14's fixture test in test/private-copy.test.ts covers",
      detail: [],
    });
  }, 120_000);

  it("4e pins a document that names nothing of the private file: no file id, content id or name", async () => {
    const mark = calls.length;
    const response = await prepare("did:privy:attack4-document", privately);

    expect(response.statusCode).toBe(200);
    const made = callsSince(mark);
    expect(made.map((call) => `${call.kind}:${call.type}`)).toEqual(["private-upload:image/jpeg", "public-upload:application/json"]);
    const id = (response.json().passport.exactHash as string).toLowerCase();
    expect(made[0]?.name).toBe(nameOf(id as Hex));

    const pinned = made[1] as Call;
    const text = (pinned.bytes as Buffer).toString("utf8");
    const document = JSON.parse(text) as Record<string, unknown>;
    expect(sealedMetadataSchema.safeParse(document).success).toBe(true);
    expect(privatelyRecheckable(document)).toBe(true);
    const leaks = [UPLOADED_ID, UPLOADED_CID, "sealed-thumb", "mypinata", "ipfs://", "https://"].filter((secret) =>
      text.includes(secret),
    );
    expect(leaks).toEqual([]);
    expect(response.body).not.toContain(UPLOADED_ID);
    expect(response.body).not.toContain(UPLOADED_CID);
    record({
      n: "4e",
      what: "POST /prepare sealed with privateRecheck, the pinned document read back byte for byte",
      verdict: `PASS, 200, strict schema accepts it, predicate says recheckable, 0 of 6 leaks (file id, content id, name, gateway, ipfs://, https://) in the document or the answer`,
      notCovered: "the live document on IPFS, which the live half's attack 7 reads",
      detail: [`keys ${Object.keys(document).join(", ")}`],
    });
  }, 60_000);
});

describe("attack 5: the sweep (B9, D5)", () => {
  const NOW = Date.parse("2026-09-25T12:00:00Z");
  /** The chain the sweep reads: true for registered, false for "registeredAt is 0", missing throws like a timed out RPC. */
  const registry = new Map<Hex, boolean>();

  function hoursAgo(hours: number): string {
    return new Date(NOW - hours * HOUR).toISOString();
  }

  function quiet(): Parameters<typeof privateSweep>[0]["log"] {
    const nothing = (): void => undefined;
    return { info: nothing, warn: nothing, error: nothing } as unknown as Parameters<typeof privateSweep>[0]["log"];
  }

  async function sweepOnce(mode: "dry" | "delete"): Promise<Awaited<ReturnType<ReturnType<typeof privateSweep>["runOnce"]>>> {
    return await privateSweep({
      mode,
      log: quiet(),
      deps: {
        registered: async (id) => {
          const answer = registry.get(id);
          if (answer === undefined) throw new Error("the RPC timed out");
          return answer;
        },
      },
    }).runOnce();
  }

  beforeEach(() => {
    account.length = 0;
    registry.clear();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  it("5a keeps a 47 hour old file whose passport never registered", async () => {
    const id = idOf(0x70);
    registry.set(id, false);
    keep(nameOf(id), hoursAgo(47));
    const mark = calls.length;
    const run = await sweepOnce("delete");

    expect(run?.outcome).toBe("finished");
    expect(run?.counts).toMatchObject({ listed: 1, young: 1, marked: 0, deleted: 0 });
    expect(callsSince(mark, "delete")).toHaveLength(0);
    expect(held(nameOf(id))).toHaveLength(1);
    record({
      n: "5a",
      what: "the sweep in delete mode, one exact name uploaded 47 hours ago, the chain saying registeredAt 0",
      verdict: `PASS, kept: ${JSON.stringify(run?.counts)}, 0 deletes`,
      notCovered: "a Pinata created_at that is wrong, which the sweep trusts as the upload time",
      detail: [],
    });
  });

  it("5b marks and deletes a 49 hour old file whose passport the chain says does not exist", async () => {
    const id = idOf(0x71);
    registry.set(id, false);
    keep(nameOf(id), hoursAgo(49));
    const mark = calls.length;
    const run = await sweepOnce("delete");

    expect(run?.outcome).toBe("finished");
    expect(run?.counts).toMatchObject({ listed: 1, young: 0, marked: 1, deleted: 1, failed: 0 });
    expect(callsSince(mark, "delete")).toHaveLength(1);
    expect(held(nameOf(id))).toHaveLength(0);
    record({
      n: "5b",
      what: "the sweep in delete mode, one exact name uploaded 49 hours ago, the chain saying registeredAt 0",
      verdict: `LANDED AS EXPECTED, marked and deleted: ${JSON.stringify(run?.counts)}; an abandoned prepare is what the sweep exists for`,
      notCovered: "a creator who signs more than 48 hours after /prepare, whose copy is gone by then; the studio registers minutes after prepare",
      detail: [],
    });
  });

  it("5c marks nothing when the chain read errors, even for a file the chain already answered for", async () => {
    const answered = idOf(0x72);
    const unanswered = idOf(0x73);
    registry.set(answered, false);
    keep(nameOf(answered), hoursAgo(60));
    keep(nameOf(unanswered), hoursAgo(60));
    const mark = calls.length;
    const run = await sweepOnce("delete");

    expect(run?.outcome).toBe("stopped");
    expect(run?.counts.marked).toBe(0);
    expect(callsSince(mark, "delete")).toHaveLength(0);
    expect(held(nameOf(answered))).toHaveLength(1);
    record({
      n: "5c",
      what: "the sweep in delete mode, two orphans 60 hours old, the chain answering one and throwing on the other",
      verdict: `REFUSED to delete, outcome stopped, marked ${String(run?.counts.marked)}, 0 deletes: one doubt stops the run`,
      notCovered: "an RPC that answers registeredAt 0 for a passport it lags behind on, which the 48 hour wait is there for",
      detail: [],
    });
  });

  it("5d deletes nothing in dry mode, only counts what it would", async () => {
    const id = idOf(0x74);
    registry.set(id, false);
    keep(nameOf(id), hoursAgo(72));
    const mark = calls.length;
    const run = await sweepOnce("dry");

    expect(run?.mode).toBe("dry");
    expect(run?.counts).toMatchObject({ marked: 1, deleted: 0 });
    expect(callsSince(mark, "delete")).toHaveLength(0);
    expect(held(nameOf(id))).toHaveLength(1);
    record({
      n: "5d",
      what: "the sweep in dry mode, one orphan 72 hours old",
      verdict: `PASS, marked ${String(run?.counts.marked)}, deleted ${String(run?.counts.deleted)}, ${counted(mark)}, the file still kept`,
      notCovered: "which mode Railway runs, which /health shows and the live half does not read",
      detail: [],
    });
  });

  it("5e skips a name with a suffix, whatever its age and whatever the chain says", async () => {
    const id = idOf(0x75);
    registry.set(id, false);
    keep(`${nameOf(id)}.old`, hoursAgo(72));
    const mark = calls.length;
    const run = await sweepOnce("delete");

    expect(run?.outcome).toBe("finished");
    expect(run?.counts).toMatchObject({ listed: 1, oddNames: 1, marked: 0, deleted: 0 });
    expect(callsSince(mark, "delete")).toHaveLength(0);
    expect(held(`${nameOf(id)}.old`)).toHaveLength(1);
    record({
      n: "5e",
      what: "the sweep in delete mode, sealed-thumb-<orphan id>.jpg.old uploaded 72 hours ago",
      verdict: `REFUSED to delete, counted as an odd name: ${JSON.stringify(run?.counts)}`,
      notCovered: "files outside the sealed-thumb- prefix, which the sweep never lists",
      detail: [],
    });
  });
});
