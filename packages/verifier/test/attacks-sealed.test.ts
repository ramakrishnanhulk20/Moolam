// Attack pass 3, the route half: the sealed-picture feature attacked on purpose, one attack per
// promise and per entry point under "Sealed pictures" in docs/security/threat-model.md. Every attack here runs through the real routes with the real signer, the real
// sealed pipeline and the real strict schema. Pinata is answered by a recording client at the fetch
// layer, Privy tokens are signed by a key made in this file, and the registry reads are stubbed.
// Each attack pushes one line saying what it found and what it did not cover, and the lines are
// printed together at the end so the run can be saved as the proof.
// Does NOT cover invariants 3 and 8 (what the studio shows and refuses before the passkey prompt,
// which is the browser's half), a real Pinata, Privy or chain call (the live half is
// packages/agents/scripts/attack-pass-3.ts), or what a CDN in front of the service does with the
// no-store header.

import fs, { mkdirSync, readdirSync, existsSync, rmdirSync, statSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { SignJWT, generateKeyPair } from "jose";
import sharp from "sharp";
import { getAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

const APP_ID = vi.hoisted(() => {
  const id = "moolamtestapp0000003";
  process.env.PRIVY_APP_ID = id;
  process.env.PINATA_JWT = "test-token-not-a-real-pinata-jwt";
  process.env.PINATA_GATEWAY_URL = "https://moolam-test.mypinata.cloud/ipfs/";
  process.env.GENERATE_PER_DAY = "2";
  process.env.GENERATOR_AGENT_ID = "10249";
  process.env.EDITS_PER_DAY = "2";
  process.env.GLOBAL_PREPARES_PER_DAY = "300";
  process.env.GLOBAL_GENERATIONS_PER_DAY = "60";
  process.env.GLOBAL_UNSEALS_PER_DAY = "60";
  return id;
});

const stubs = vi.hoisted(() => ({
  passportExists: vi.fn(),
  createImage: vi.fn(),
  sign: vi.fn(),
  wallet: vi.fn(),
  embeddedWallets: vi.fn(),
  readPassport: vi.fn(),
  holderOf: vi.fn(),
  readMetadataDocument: vi.fn(),
  findUnsealRecord: vi.fn(),
  readUnsealRecord: vi.fn(),
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

vi.mock("../src/generate/imageModel.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/generate/imageModel.js")>()),
  createImage: stubs.createImage,
}));

vi.mock("../src/generate/generatorSigner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/generate/generatorSigner.js")>()),
  generatorWallet: stubs.wallet,
  signPassportAsGenerator: stubs.sign,
}));

// Only the reads that leave the process are stubbed. Every check the unseal route makes is real.
vi.mock("../src/unseal.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/unseal.js")>()),
  readPassport: stubs.readPassport,
  holderOf: stubs.holderOf,
  readMetadataDocument: stubs.readMetadataDocument,
  findUnsealRecord: stubs.findUnsealRecord,
  readUnsealRecord: stubs.readUnsealRecord,
}));

const { PACKAGE_ROOT } = await import("../src/env.js");
const { sealedMetadataSchema } = await import("../src/sealed.js");
const { pictureReader, unsealRecord } = await import("../src/unseal.js");
const { buildServer } = await import("../src/server.js");
const { contentIdOf } = await import("../src/ipfs/pinata.js");
const { makeImage } = await import("./helpers.js");

const UPLOAD_URL = "https://uploads.pinata.cloud/v3/files";
const PRIVATE_FILES_URL = "https://api.pinata.cloud/v3/files/private";
const PROMPT = "A lighthouse in a monsoon storm, painted in thick oils";
const CREATOR = getAddress("0x85a88ca81ff5f681d96ab86fa60ccb8452a139a6" as Hex);
const emptySource = { load: async () => [] };

/** The keys a sealed document may carry, from the strict schema itself rather than a copy of it. */
const ALLOWED_KEYS = Object.keys(sealedMetadataSchema.shape).sort();

interface Pin {
  name: string;
  type: string;
  bytes: Buffer;
}

interface Line {
  n: string;
  what: string;
  verdict: string;
  notCovered: string;
  detail: string[];
}

const pins: Pin[] = [];
const lines: Line[] = [];
let IMAGE: Buffer;
let signing: CryptoKey;
let verifying: CryptoKey;
let agent: PrivateKeyAccount;
let app: FastifyInstance;

function record(line: Line): void {
  lines.push(line);
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

function multipart(
  fields: Record<string, string>,
  file: Buffer,
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = "----moolamattack3";
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
  subject: string | undefined,
  fields: Record<string, string>,
  options: { file?: Buffer; on?: FastifyInstance } = {},
): Promise<LightMyRequestResponse> {
  const { payload, headers } = multipart(fields, options.file ?? IMAGE);
  return await (options.on ?? app).inject({
    method: "POST",
    url: "/prepare",
    payload,
    headers: subject === undefined ? headers : { ...headers, authorization: `Bearer ${await token(subject)}` },
    remoteAddress: "198.51.100.30",
  });
}

async function generate(
  subject: string | undefined,
  body: Record<string, unknown> | string,
  on?: FastifyInstance,
): Promise<LightMyRequestResponse> {
  return await (on ?? app).inject({
    method: "POST",
    url: "/generate",
    payload: body,
    headers: {
      "content-type": "application/json",
      ...(subject === undefined ? {} : { authorization: `Bearer ${await token(subject)}` }),
    },
    remoteAddress: "198.51.100.31",
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

function pinsSince(mark: number): Pin[] {
  return pins.slice(mark);
}

function documentOf(pin: Pin | undefined): Record<string, unknown> {
  expect(pin, "a pinned document").toBeDefined();
  return JSON.parse((pin as Pin).bytes.toString("utf8")) as Record<string, unknown>;
}

/** The pinned document with the long hashes cut short, so a quoted line stays readable. */
function quote(document: Record<string, unknown>): string {
  return JSON.stringify(document).replace(/0x([0-9a-f]{10})[0-9a-f]{40,}/g, "0x$1...");
}

/** The one sealed document a request pinned, checked against the strict schema on the way in. */
function onlySealedDocument(made: Pin[], label: string): Record<string, unknown> {
  expect(made.map((pin) => pin.type), label).toEqual(["application/json"]);
  const document = documentOf(made[0]);
  expect(sealedMetadataSchema.safeParse(document).success, label).toBe(true);
  expect(Object.keys(document).every((key) => ALLOWED_KEYS.includes(key)), label).toBe(true);
  return document;
}

function recordingPinata(): void {
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    // A finished unseal looks for a private copy to delete. None was kept for these passports, and
    // the lookup must never reach the real account.
    if (url.startsWith(`${PRIVATE_FILES_URL}?`)) {
      return new Response(JSON.stringify({ data: { files: [], next_page_token: "" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
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

/** Every file below `directory`, relative to it, so a new file anywhere under a temp dir shows. */
function walk(directory: string, prefix = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    const name = path.join(prefix, entry);
    found.push(name);
    if (statSync(full).isDirectory()) {
      found.push(...walk(full, name));
    }
  }
  return found.sort();
}

/**
 * Records every path JavaScript asks node:fs to open, write or create while `work` runs.
 *
 * The spy is on the module object and pushed through to the named exports, so an
 * `import { writeFileSync } from "node:fs"` elsewhere is caught too. It cannot see the C2PA
 * signer's own Rust code, which is why the attack also lists the directories before and after.
 */
async function spyOnFileWrites<T>(work: () => Promise<T>): Promise<{ result: T; touched: string[] }> {
  const touched: string[] = [];
  const target = fs as unknown as Record<string, unknown>;
  const promises = fs.promises as unknown as Record<string, unknown>;
  const names = ["open", "openSync", "writeFile", "writeFileSync", "appendFile", "appendFileSync", "createWriteStream", "mkdtemp", "mkdtempSync", "mkdir", "mkdirSync", "copyFile", "copyFileSync", "rename", "renameSync"];
  const promiseNames = ["open", "writeFile", "appendFile", "mkdtemp", "mkdir", "copyFile", "rename"];
  const kept = new Map<string, unknown>();
  const keptPromises = new Map<string, unknown>();

  const wrap = (real: unknown, name: string) =>
    (...args: unknown[]): unknown => {
      const first = args[0];
      if (typeof first === "string" || first instanceof URL || Buffer.isBuffer(first)) {
        const opened = name.startsWith("open") ? String(args[1] ?? "r") : "w";
        if (opened !== "r") {
          touched.push(`${name} ${String(first)}`);
        }
      }
      return (real as (...rest: unknown[]) => unknown)(...args);
    };

  for (const name of names) {
    kept.set(name, target[name]);
    target[name] = wrap(target[name], name);
  }
  for (const name of promiseNames) {
    keptPromises.set(name, promises[name]);
    promises[name] = wrap(promises[name], `promises.${name}`);
  }
  syncBuiltinESMExports();
  try {
    return { result: await work(), touched };
  } finally {
    for (const [name, real] of kept) target[name] = real;
    for (const [name, real] of keptPromises) promises[name] = real;
    syncBuiltinESMExports();
  }
}

/**
 * Everything the service logs while `work` runs, by both roads pino takes to the terminal: a plain
 * node run writes through process.stdout, and under this runner pino writes to descriptor 1 through
 * fs.write. The attack insists the capture is not empty, so a third road would fail it rather than
 * let it prove nothing.
 */
async function captureLog<T>(work: () => Promise<T>): Promise<{ result: T; logged: string }> {
  const chunks: string[] = [];
  const keep = (chunk: unknown): void => {
    if (typeof chunk === "string") chunks.push(chunk);
    else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk).toString("utf8"));
  };
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    keep(chunk);
    return true;
  });
  const realWrite = fs.write;
  const realWriteSync = fs.writeSync;
  const patched = fs as unknown as Record<string, unknown>;
  patched.write = (...args: unknown[]): unknown => {
    if (args[0] === 1) keep(args[1]);
    return (realWrite as unknown as (...rest: unknown[]) => unknown)(...args);
  };
  patched.writeSync = (...args: unknown[]): unknown => {
    if (args[0] === 1) keep(args[1]);
    return (realWriteSync as unknown as (...rest: unknown[]) => unknown)(...args);
  };
  try {
    const result = await work();
    // The completed line is written after the reply and pino flushes on its own clock.
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { result, logged: chunks.join("") };
  } finally {
    patched.write = realWrite;
    patched.writeSync = realWriteSync;
    stdout.mockRestore();
  }
}

/** The longest unbroken run of base64 or base64url characters in a text. */
function longestBase64Run(text: string): number {
  let longest = 0;
  for (const match of text.matchAll(/[A-Za-z0-9+/_-]+={0,2}/g)) {
    longest = Math.max(longest, match[0].length);
  }
  return longest;
}

beforeAll(async () => {
  IMAGE = await makeImage(21);
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
    model: "gpt-image-1-mini",
    promptUsed: prompt,
  }));
  recordingPinata();

  app = await buildServer({
    source: emptySource,
    logger: false,
    prepare: { keys: verifying },
    generate: { keys: verifying },
    unseal: { keys: verifying },
  });
  await app.ready();
}, 120_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await app.close();

  const say = (text = ""): void => {
    console.log(text);
  };
  say("Moolam attack pass 3, the route half: sealed pictures, executed with vitest.");
  say(`date        ${new Date().toISOString()}`);
  say("pins        recorded at the fetch layer; tokens signed by a key made in this file; chain reads stubbed");
  say();
  for (const line of lines) {
    say(`  ${line.n.padEnd(4)}${line.what}`);
    say(`      ${line.verdict}; not covered: ${line.notCovered}`);
    for (const detail of line.detail) {
      say(`        ${detail}`);
    }
  }
});

describe("attack 1: nothing of the picture is stored or published (invariants 1 and 2)", () => {
  it("1a pins one strict JSON document and not a single file, on /prepare and on /generate", async () => {
    const preparedMark = pins.length;
    const prepared = await prepare("did:privy:attack-1a-prepare", { title: "Sealed nets", kind: "human", sealed: "true" });
    expect(prepared.statusCode).toBe(200);
    const fromPrepare = pinsSince(preparedMark);

    const drawnMark = pins.length;
    const generated = await generate("did:privy:attack-1a-generate", drawn("Sealed lighthouse", { sealed: true }));
    expect(generated.statusCode).toBe(200);
    const fromGenerate = pinsSince(drawnMark);

    const prepDoc = onlySealedDocument(fromPrepare, "/prepare");
    const genDoc = onlySealedDocument(fromGenerate, "/generate");
    expect(fromPrepare.filter((pin) => pin.type !== "application/json")).toHaveLength(0);
    expect(fromGenerate.filter((pin) => pin.type !== "application/json")).toHaveLength(0);

    record({
      n: "1a",
      what: "sealed /prepare and sealed /generate, pins counted at the fetch layer",
      verdict: `PASS, /prepare made ${fromPrepare.length} pin (0 files), /generate made ${fromGenerate.length} pin (0 files), both documents pass the strict schema`,
      notCovered: "a real Pinata upload, only the call this service makes to it",
      detail: [`/prepare pinned  ${quote(prepDoc)}`, `/generate pinned ${quote(genDoc)}`],
    });
  }, 120_000);

  it("1b drops every smuggled body field, and refuses a body with too many of them", async () => {
    const smuggled: Record<string, string> = {
      image: "ipfs://bafysmuggledimage",
      thumbnail: "ipfs://bafysmuggledthumb",
      manifest: "ipfs://bafysmuggledmanifest",
      prompt: "a secret prompt describing the smuggled picture",
      animation_url: "https://evil.example/smuggled.mp4",
      external_url: "https://evil.example/smuggled",
    };
    const detail: string[] = [];

    // The multipart parser takes four text fields, so title, kind and sealed leave room for one.
    for (const [field, value] of Object.entries(smuggled)) {
      const mark = pins.length;
      const response = await prepare(`did:privy:attack-1b-${field}`, {
        title: "Smuggle attempt",
        kind: "human",
        sealed: "true",
        [field]: value,
      });
      expect(response.statusCode, field).toBe(200);
      const document = onlySealedDocument(pinsSince(mark), field);
      expect(document[field], field).toBeUndefined();
      expect(JSON.stringify(document), field).not.toContain(value);
      detail.push(`/prepare + ${field.padEnd(13)} ${response.statusCode}, pinned keys ${Object.keys(document).sort().join(",")}`);
    }

    const allMark = pins.length;
    const all = await prepare("did:privy:attack-1b-all", {
      title: "Smuggle all six",
      kind: "human",
      sealed: "true",
      ...smuggled,
    });
    expect(all.statusCode).toBeGreaterThanOrEqual(400);
    expect(pinsSince(allMark)).toHaveLength(0);
    detail.push(`/prepare + all six at once   ${all.statusCode} ${all.body}, pins 0`);

    const { prompt: _prompt, ...forGenerate } = smuggled;
    const genMark = pins.length;
    const generated = await generate(
      "did:privy:attack-1b-generate",
      drawn("Smuggled into a drawing", { sealed: true, ...forGenerate }),
    );
    expect(generated.statusCode).toBe(200);
    const genDoc = onlySealedDocument(pinsSince(genMark), "/generate smuggled");
    for (const [field, value] of Object.entries(forGenerate)) {
      expect(genDoc[field], field).toBeUndefined();
      expect(JSON.stringify(genDoc), field).not.toContain(value);
    }
    expect(genDoc.prompt).toBeUndefined();
    expect(JSON.stringify(genDoc)).not.toContain("lighthouse");
    detail.push(`/generate + image,thumbnail,manifest,animation_url,external_url  ${generated.statusCode}, pinned ${quote(genDoc)}`);

    record({
      n: "1b",
      what: "smuggled fields image, thumbnail, manifest, prompt, animation_url, external_url",
      verdict: "REFUSED, every one dropped before the pin (the strict schema's own output is what is pinned), and all six in one body refused with nothing pinned",
      notCovered: "a field smuggled inside the training statement, which consent.ts refuses and test/consent.test.ts covers",
      detail,
    });
  }, 240_000);

  it("1c publishes a data: or ipfs:// title as the creator's own words, capped at 120 characters", async () => {
    const dataTitle = `data:image/jpeg;base64,${IMAGE.toString("base64")}`.slice(0, 120);
    const ipfsTitle = "ipfs://bafkreiattackerchosenlinkinthetitle";
    const detail: string[] = [];

    for (const [label, title] of [
      ["data: URI", dataTitle],
      ["ipfs:// link", ipfsTitle],
    ] as const) {
      const mark = pins.length;
      const response = await prepare(`did:privy:attack-1c-${label.slice(0, 4)}`, { title, kind: "human", sealed: "true" });
      expect(response.statusCode, label).toBe(200);
      const document = onlySealedDocument(pinsSince(mark), label);
      expect(document.name, label).toBe(title);
      detail.push(`${label.padEnd(13)} pinned ${quote(document)}`);
    }

    const tooLong = await prepare("did:privy:attack-1c-long", {
      title: `data:image/jpeg;base64,${IMAGE.toString("base64")}`.slice(0, 121),
      kind: "human",
      sealed: "true",
    });
    expect(tooLong.statusCode).toBe(400);
    detail.push(`a 121 character data: title   ${tooLong.statusCode} ${tooLong.body}`);

    record({
      n: "1c",
      what: "a title that is a data: URI and one that is an ipfs:// link",
      verdict:
        "LANDED AS EXPECTED, the title is published as typed: it is the creator's own public words (threat model B, Metadata), and 120 characters hold at most 72 bytes of a picture",
      notCovered: "how a reader renders the name, which is the web's half and is not executed here",
      detail,
    });
  }, 120_000);

  it("1d leaves nothing on disk after a sealed prepare with the C2PA signer on", async () => {
    const privateTemp = path.join(os.tmpdir(), `moolam-attack3-${Date.now()}`);
    const kept = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
    mkdirSync(privateTemp, { recursive: true });
    const watched = [...new Set([process.cwd(), PACKAGE_ROOT, path.join(PACKAGE_ROOT, "test-assets")])];

    let before: string[][] = [];
    let after: string[][] = [];
    let tempBefore: string[] = [];
    let tempAfter: string[] = [];
    let touched: string[] = [];
    let response: LightMyRequestResponse;
    try {
      process.env.TMPDIR = privateTemp;
      process.env.TEMP = privateTemp;
      process.env.TMP = privateTemp;
      expect(os.tmpdir()).toBe(privateTemp);

      before = watched.map((directory) => readdirSync(directory).sort());
      tempBefore = walk(privateTemp);
      const run = await spyOnFileWrites(
        async () => await prepare("did:privy:attack-1d", { title: "Nothing on disk", kind: "human", sealed: "true" }),
      );
      response = run.result;
      touched = run.touched;
      tempAfter = walk(privateTemp);
      after = watched.map((directory) => readdirSync(directory).sort());
    } finally {
      process.env.TMPDIR = kept.TMPDIR;
      process.env.TEMP = kept.TEMP;
      process.env.TMP = kept.TMP;
    }

    expect(response.statusCode).toBe(200);
    // The signer really ran: the manifest is inside the file the creator gets back.
    expect(response.json().manifest).toEqual({ embedded: true });

    const added = watched.map((directory, index) =>
      (after[index] ?? []).filter((entry) => !(before[index] ?? []).includes(entry)),
    );
    const tempAdded = tempAfter.filter((entry) => !tempBefore.includes(entry));
    expect(tempAdded).toEqual([]);
    added.forEach((entries, index) => {
      expect(entries, watched[index]).toEqual([]);
    });
    // Whatever JavaScript opened for writing, nothing of it is left once the request is over.
    const survivors = touched
      .map((entry) => entry.slice(entry.indexOf(" ") + 1))
      .filter((file) => existsSync(file));
    expect(survivors).toEqual([]);
    rmdirSync(privateTemp);

    record({
      n: "1d",
      what: "a sealed prepare with the signer on, disk listed before and after, node:fs spied",
      verdict: `PASS, 0 new files in the private temp dir, 0 in ${watched.length} watched directories, ${touched.length} JavaScript write opens, 0 survivors`,
      notCovered: "writes by the Rust signer outside the temp dir and the watched directories, which only a system-level trace would show",
      detail: [
        `temp dir entries before ${tempBefore.length}, after ${tempAfter.length}`,
        `watched ${watched.join(", ")}`,
        `write opens seen ${touched.length === 0 ? "none" : touched.join("; ")}`,
      ],
    });
  }, 120_000);

  it("1e leaves the orphan pin a prepare makes before any registration, as documented", async () => {
    const mark = pins.length;
    const response = await prepare("did:privy:attack-1e", { title: "Walked away", kind: "human", sealed: "true" });
    expect(response.statusCode).toBe(200);
    const document = onlySealedDocument(pinsSince(mark), "orphan");
    // Nothing in this file sends a registration, so this document is exactly the orphan the model names.

    record({
      n: "1e",
      what: "a sealed prepare that is never registered (the orphan pin)",
      verdict:
        "LANDED AS EXPECTED, the document is pinned before the creator signs because its address is part of what they sign; it holds only the title, the fingerprints and the hash, which the studio lists before it calls the service",
      notCovered: "the later tidy that would unpin a document whose passport never appeared within a day, which does not exist yet",
      detail: [`pinned and never registered: ${quote(document)}`],
    });
  }, 60_000);
});

describe("attack 2: nothing cached or logged (invariant 4)", () => {
  it("2a answers no-store on every sealed answer, the refusals included, and logs no picture", async () => {
    const loud = await buildServer({
      source: emptySource,
      logger: true,
      prepare: { keys: verifying },
      generate: { keys: verifying },
      unseal: { keys: verifying },
    });
    await loud.ready();

    const oversize = Buffer.concat([IMAGE, Buffer.alloc(20 * 1024 * 1024 + 1 - IMAGE.length, 0x5a)]);
    const answers: { label: string; response: LightMyRequestResponse }[] = [];
    let captured = "";
    try {
      const run = await captureLog(async () => {
        const sealed = { kind: "human", sealed: "true" };
        answers.push({
          label: "/prepare 200 sealed",
          response: await prepare("did:privy:attack-2a-ok", { title: "Kept out of the log", ...sealed }, { on: loud }),
        });
        answers.push({
          label: "/prepare 400 bad field",
          response: await prepare("did:privy:attack-2a-bad", { title: "Bad flag", kind: "human", sealed: "maybe" }, { on: loud }),
        });
        answers.push({
          label: "/prepare 401 no token",
          response: await prepare(undefined, { title: "No token", ...sealed }, { on: loud }),
        });
        answers.push({
          label: "/prepare 413 over the byte cap",
          response: await prepare("did:privy:attack-2a-big", { title: "Too big", ...sealed }, { on: loud, file: oversize }),
        });
        // Twenty refusals spend the creator's hourly allowance, because the limiter counts before
        // the handler reads a field, and the twenty-first is the limiter's own 429.
        for (let i = 0; i < 20; i += 1) {
          await prepare("did:privy:attack-2a-limit", { title: "   ", ...sealed }, { on: loud });
        }
        answers.push({
          label: "/prepare 429 hourly limit",
          response: await prepare("did:privy:attack-2a-limit", { title: "Over the limit", ...sealed }, { on: loud }),
        });

        answers.push({
          label: "/generate 200 sealed",
          response: await generate("did:privy:attack-2a-gen", drawn("Drawn out of the log", { sealed: true }), loud),
        });
        answers.push({
          label: "/generate 400 bad field",
          response: await generate("did:privy:attack-2a-gen-bad", drawn("Bad flag", { sealed: "yes" }), loud),
        });
        answers.push({
          label: "/generate 401 no token",
          response: await generate(undefined, drawn("No token", { sealed: true }), loud),
        });
        answers.push({
          label: "/generate 413 over the body cap",
          response: await generate(
            "did:privy:attack-2a-gen-big",
            JSON.stringify(drawn("Too big", { sealed: true, padding: "x".repeat(17 * 1024) })),
            loud,
          ),
        });
        await generate("did:privy:attack-2a-gen-quota", drawn("Quota one", { sealed: true }), loud);
        await generate("did:privy:attack-2a-gen-quota", drawn("Quota two", { sealed: true }), loud);
        answers.push({
          label: "/generate 429 daily quota",
          response: await generate("did:privy:attack-2a-gen-quota", drawn("Quota three", { sealed: true }), loud),
        });

        const unseal = async (
          fields: Record<string, string>,
          file: Buffer,
          subject?: string,
        ): Promise<LightMyRequestResponse> => {
          const { payload, headers } = multipart(fields, file);
          return await loud.inject({
            method: "POST",
            url: "/unseal",
            payload,
            headers: subject === undefined ? headers : { ...headers, authorization: `Bearer ${await token(subject)}` },
            remoteAddress: "198.51.100.32",
          });
        };
        answers.push({
          label: "/unseal 400 bad field",
          response: await unseal({ passportId: "0xnothex" }, IMAGE, "did:privy:attack-2a-unseal"),
        });
        answers.push({ label: "/unseal 401 no token", response: await unseal({ passportId: `0x${"ab".repeat(32)}` }, IMAGE) });
        answers.push({
          label: "/unseal 413 over the byte cap",
          response: await unseal({ passportId: `0x${"ab".repeat(32)}` }, oversize, "did:privy:attack-2a-unseal"),
        });
        // The service-wide limit is sixty a minute per address, and this address has sent three.
        let limited: LightMyRequestResponse | undefined;
        for (let i = 0; i < 60 && limited === undefined; i += 1) {
          const response = await unseal({ passportId: `0x${"ab".repeat(32)}` }, IMAGE);
          if (response.statusCode === 429) limited = response;
        }
        answers.push({ label: "/unseal 429 per-minute limit", response: limited as LightMyRequestResponse });
      });
      captured = run.logged;
    } finally {
      await loud.close();
    }

    const expected: Record<string, number> = {
      "/prepare 200 sealed": 200,
      "/prepare 400 bad field": 400,
      "/prepare 401 no token": 401,
      "/prepare 413 over the byte cap": 413,
      "/prepare 429 hourly limit": 429,
      "/generate 200 sealed": 200,
      "/generate 400 bad field": 400,
      "/generate 401 no token": 401,
      "/generate 413 over the body cap": 413,
      "/generate 429 daily quota": 429,
      "/unseal 400 bad field": 400,
      "/unseal 401 no token": 401,
      "/unseal 413 over the byte cap": 413,
      "/unseal 429 per-minute limit": 429,
    };
    const detail: string[] = [];
    for (const { label, response } of answers) {
      expect(response, label).toBeDefined();
      expect(response.statusCode, label).toBe(expected[label]);
      expect(response.headers["cache-control"], label).toBe("no-store");
      detail.push(`${label.padEnd(32)} ${response.statusCode} cache-control: ${String(response.headers["cache-control"])}`);
    }
    expect(answers).toHaveLength(Object.keys(expected).length);

    // The capture caught the service talking, or the scan below proves nothing.
    expect(captured).toContain("request completed");
    expect(captured).toContain("rejected");

    const signed = answers
      .filter(({ label }) => label.endsWith("200 sealed"))
      .map(({ response }) => response.json().signedFile.bytes as string);
    expect(signed).toHaveLength(2);
    const longest = longestBase64Run(captured);
    expect(longest).toBeLessThanOrEqual(200);
    for (const base64 of signed) {
      const raw = Buffer.from(base64, "base64");
      expect(captured).not.toContain(base64.slice(0, 64));
      expect(captured).not.toContain(base64.slice(-64));
      expect(captured).not.toContain(raw.subarray(0, 48).toString("latin1"));
      expect(captured).not.toContain(raw.subarray(raw.length - 48).toString("latin1"));
      expect(captured).not.toContain(raw.subarray(0, 32).toString("hex"));
    }
    expect(captured).not.toContain(IMAGE.toString("base64").slice(0, 64));
    expect(captured).not.toContain(IMAGE.subarray(0, 48).toString("latin1"));
    expect(captured).not.toContain(IMAGE.subarray(0, 32).toString("hex"));

    const logLines = captured.split("\n").filter((row) => row.trim().length > 0).length;
    detail.push(
      `log captured ${captured.length} characters over ${logLines} lines; longest base64 run ${longest} characters; no slice of the two signed files or the upload, as base64, raw or hex`,
    );
    record({
      n: "2a",
      what: "every sealed answer's cache header, and the logger's output, on /prepare, /generate and /unseal",
      verdict: `PASS, ${answers.length} of ${answers.length} answers no-store (200, 400, 401, 413 and 429 on each route but /unseal's 200, which attack 3e shows), 0 picture bytes in the log`,
      notCovered: "a proxy or CDN that ignores no-store, and the host's own request log, which is outside this process",
      detail,
    });
  }, 300_000);
});

/** What a sealed registration handed back, read from the real /prepare answer. */
interface Sealed {
  bytes: Buffer;
  passportId: Hex;
  phash: bigint;
  blockhash: Hex;
  document: Record<string, unknown>;
}

async function sealThroughTheRoute(subject: string, title: string, file: Buffer): Promise<Sealed> {
  const mark = pins.length;
  const response = await prepare(subject, { title, kind: "human", sealed: "true" }, { file });
  expect(response.statusCode, title).toBe(200);
  const answer = response.json();
  return {
    bytes: Buffer.from(answer.signedFile.bytes as string, "base64"),
    passportId: answer.passport.exactHash as Hex,
    phash: BigInt(answer.passport.phash as string),
    blockhash: answer.passport.blockhash256 as Hex,
    document: onlySealedDocument(pinsSince(mark), title),
  };
}

describe("attack 3: only the holder unseals, and only the registered bytes (invariants 5 and 6)", () => {
  const STRANGER = getAddress("0x1111111111111111111111111111111111111111");
  const METADATA_URI = "ipfs://bafysealeddocumentforattack3";

  let sealed: Sealed;

  function chainHolds(which: Sealed, overrides: Record<string, unknown> = {}): void {
    stubs.readPassport.mockReset().mockResolvedValue({
      registeredAt: 1_758_000_000,
      phash: which.phash,
      blockhash256: which.blockhash,
      fingerprintVersion: 1,
      metadataURI: METADATA_URI,
      ...overrides,
    });
    stubs.readMetadataDocument.mockReset().mockResolvedValue(which.document);
  }

  async function unseal(subject: string, file: Buffer, passportId: Hex): Promise<LightMyRequestResponse> {
    const { payload, headers } = multipart({ passportId }, file);
    return await app.inject({
      method: "POST",
      url: "/unseal",
      payload,
      headers: { ...headers, authorization: `Bearer ${await token(subject)}` },
      remoteAddress: "198.51.100.33",
    });
  }

  /** A picture of pure noise: the one thing a 512 pixel thumbnail cannot squeeze under 60 KB. */
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

  beforeAll(async () => {
    sealed = await sealThroughTheRoute("did:privy:attack-3-seal", "Sealed for attack three", await makeImage(33));
  }, 60_000);

  beforeEach(() => {
    chainHolds(sealed);
    stubs.holderOf.mockReset().mockResolvedValue(CREATOR);
    stubs.embeddedWallets.mockReset().mockResolvedValue([CREATOR]);
    stubs.findUnsealRecord.mockReset().mockResolvedValue({ state: "none" });
  });

  it("3a refuses the right bytes from a caller whose wallet is not ownerOf, with nothing pinned", async () => {
    stubs.embeddedWallets.mockResolvedValue([STRANGER]);
    const mark = pins.length;
    const response = await unseal("did:privy:attack-3a", sealed.bytes, sealed.passportId);

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "not-holder" });
    expect(pinsSince(mark)).toHaveLength(0);
    expect(response.headers["cache-control"]).toBe("no-store");
    record({
      n: "3a",
      what: "the registered bytes, sent by a signed-in caller whose wallet is not the holder",
      verdict: `REFUSED, ${response.statusCode} ${response.body}, pins 0`,
      notCovered: "Privy's own mapping from a user to their wallets, which is stubbed here and read live in production",
      detail: [`caller wallets [${STRANGER}], ownerOf ${CREATOR}`],
    });
  }, 60_000);

  it("3b refuses the holder sending bytes whose SHA-256 is not the passport id, with nothing pinned", async () => {
    const mark = pins.length;
    const other = await makeImage(34);
    const response = await unseal("did:privy:attack-3b", other, sealed.passportId);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "hash-mismatch", passportId: sealed.passportId });
    expect(pinsSince(mark)).toHaveLength(0);
    expect(stubs.holderOf).not.toHaveBeenCalled();
    record({
      n: "3b",
      what: "the holder's token with a different picture under the sealed passport id",
      verdict: `REFUSED, ${response.statusCode} hash-mismatch before any chain read, pins 0`,
      notCovered: "a second preimage of SHA-256, which is out of reach by the hash's own strength",
      detail: [`passport ${sealed.passportId}`],
    });
  }, 60_000);

  it("3c refuses the right hash when the chain's fingerprint differs, with nothing pinned", async () => {
    const detail: string[] = [];
    for (const [label, overrides] of [
      ["phash off by one", { phash: sealed.phash + 1n }],
      ["block hash zeroed", { blockhash256: `0x${"00".repeat(32)}` }],
      ["fingerprint version 2", { fingerprintVersion: 2 }],
    ] as const) {
      chainHolds(sealed, overrides);
      const mark = pins.length;
      const response = await unseal(`did:privy:attack-3c-${label.slice(0, 5)}`, sealed.bytes, sealed.passportId);
      expect(response.statusCode, label).toBe(400);
      expect(response.json().error, label).toBe("fingerprint-mismatch");
      expect(pinsSince(mark), label).toHaveLength(0);
      detail.push(`${label.padEnd(22)} ${response.statusCode} fingerprint-mismatch, pins 0`);
    }
    record({
      n: "3c",
      what: "the holder and the right bytes, with the chain's fingerprint read back different",
      verdict: "REFUSED, all three differences answered fingerprint-mismatch, pins 0",
      notCovered: "the real registry read, which is stubbed here to say what an older fingerprint recipe would have stored",
      detail,
    });
  }, 120_000);

  it("3d applies the public path's thumbnail rule when a sealed picture too big for it is unsealed", async () => {
    const noise = await makeNoiseImage();
    const publicMark = pins.length;
    const publicTry = await prepare("did:privy:attack-3d-public", { title: "Noise, public", kind: "human" }, { file: noise });
    const publicPins = pinsSince(publicMark).length;
    expect(publicTry.statusCode).toBeGreaterThanOrEqual(400);
    expect(publicPins).toBe(0);

    const loud = await sealThroughTheRoute("did:privy:attack-3d-seal", "Noise, sealed", noise);
    chainHolds(loud);
    const mark = pins.length;
    const response = await unseal("did:privy:attack-3d", loud.bytes, loud.passportId);

    expect(response.statusCode).toBe(422);
    const answer = response.json();
    expect(answer.error).toBe("thumbnail-too-large");
    expect(answer.limit).toBe(60_000);
    expect(answer.reason).toContain("Chainlink");
    expect(pinsSince(mark)).toHaveLength(0);
    record({
      n: "3d",
      what: "a picture whose thumbnail cannot fit the workflow's 60 KB budget, registered sealed and then unsealed",
      verdict: `REFUSED, unseal ${response.statusCode} thumbnail-too-large with the 60,000 byte limit named, pins 0`,
      notCovered: "the Chainlink workflow's own fetch, whose 60 KB budget is taken from the workflow and not measured here",
      detail: [
        `public /prepare of the same picture   ${publicTry.statusCode} ${publicTry.body}, pins ${publicPins}`,
        `sealed /prepare of it                 200, one JSON pin, passport ${loud.passportId}`,
        `unseal                                ${response.statusCode} ${response.body}`,
      ],
    });
  }, 120_000);

  it("3e publishes exactly the documented four pins for the holder, the right bytes and a matching fingerprint", async () => {
    const mark = pins.length;
    const response = await unseal("did:privy:attack-3e", sealed.bytes, sealed.passportId);

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const made = pinsSince(mark);
    expect(made).toHaveLength(4);
    const picture = made.find((pin) => pin.type === "image/jpeg" && !pin.name.includes("-thumb")) as Pin;
    const thumbnail = made.find((pin) => pin.name.endsWith("-thumb.jpg")) as Pin;
    const manifest = made.find((pin) => pin.name.endsWith("-c2pa.json")) as Pin;
    const record3 = made.find((pin) => pin.name === `unseal-${sealed.passportId}.json`) as Pin;
    expect(picture.bytes.equals(sealed.bytes)).toBe(true);
    expect(thumbnail.bytes.length).toBeLessThanOrEqual(60_000);
    expect(manifest.type).toBe("application/json");
    const written = documentOf(record3);
    expect(written.passportId).toBe(sealed.passportId);
    expect(written.unsealedBy).toBe(CREATOR);

    record({
      n: "3e",
      what: "positive control: the holder, the registered bytes, the chain's own fingerprint",
      verdict: "PASS, 200 no-store and exactly the four pins the route documents: picture, thumbnail, manifest, record",
      notCovered: "a real Pinata upload and a real registry read, both stubbed",
      detail: made.map((pin) => `${pin.type.padEnd(17)} ${String(pin.bytes.length).padStart(7)} bytes  ${pin.name.replace(/0x([0-9a-f]{10})[0-9a-f]{54}/, "0x$1...")}`),
    });
  }, 60_000);
});

describe("attack 4: sealed never reads as public or broken (invariant 7)", () => {
  const METADATA_URI = "ipfs://bafysealeddocumentforattack4";
  const UNSEALED_URI = "ipfs://bafysealeddocumentforattack4c";
  const UNSEALED_AT = new Date("2026-09-22T12:27:28.000Z");
  let sealed: Sealed;
  let opened: Sealed;
  let indexed: FastifyInstance;

  beforeAll(async () => {
    sealed = await sealThroughTheRoute("did:privy:attack-4-seal", "Sealed for attack four", await makeImage(44));
    // A second sealed passport whose holder has since published the picture, the shape finding 5g
    // found live on mainnet: its document still says sealed, and an unseal record says otherwise.
    opened = await sealThroughTheRoute("did:privy:attack-4c-seal", "Sealed then opened", await makeImage(45));
    const indexedRecord = (which: Sealed, metadataURI: string) => ({
      id: which.passportId,
      phash: which.phash,
      blockhash: which.blockhash,
      creator: CREATOR,
      parentId: null,
      registeredAt: 1_758_000_000,
      metadataURI,
    });
    const documents = new Map<string, Record<string, unknown>>([
      [METADATA_URI, sealed.document],
      [UNSEALED_URI, opened.document],
    ]);
    const readDocument = async (uri: string): Promise<unknown> => {
      const document = documents.get(uri);
      expect(document, uri).toBeDefined();
      return document;
    };
    const findRecord = async (passportId: Hex) =>
      passportId === opened.passportId
        ? unsealRecord({
            passportId,
            image: "ipfs://bafyopenedimage",
            thumbnail: "ipfs://bafyopenedthumb",
            unsealedBy: CREATOR,
            unsealedAt: UNSEALED_AT,
          })
        : undefined;
    indexed = await buildServer({
      source: { load: async () => [indexedRecord(sealed, METADATA_URI), indexedRecord(opened, UNSEALED_URI)] },
      logger: false,
      picture: pictureReader({ readDocument, findRecord }),
      recheck: {
        runnerToken: "moolam-runner-token-for-attack-4",
        readDocument,
        findRecord,
      },
    });
    await indexed.ready();
  }, 60_000);

  afterAll(async () => {
    await indexed.close();
  });

  async function verify(file: Buffer): Promise<LightMyRequestResponse> {
    const { payload, headers } = multipart({}, file);
    return await indexed.inject({ method: "POST", url: "/verify", payload, headers, remoteAddress: "198.51.100.34" });
  }

  it("4a answers a copy of a sealed passport with no image or thumbnail address, and says whether it is sealed", async () => {
    const exact = await verify(sealed.bytes);
    const copy = await verify(await sharp(sealed.bytes).jpeg({ quality: 70 }).toBuffer());
    const detail: string[] = [];
    let flagged = 0;

    for (const [label, response] of [
      ["the signed file itself", exact],
      ["a quality 70 re-encode", copy],
    ] as const) {
      expect(response.statusCode, label).toBe(200);
      const answer = response.json();
      expect(answer.result.best.id, label).toBe(sealed.passportId);
      const text = response.body;
      // No address of any kind that a reader could try to open for the picture.
      expect(text, label).not.toMatch(/ipfs:\/\//);
      expect(text, label).not.toMatch(/https?:\/\//);
      expect(text, label).not.toContain("mypinata.cloud");
      expect(text, label).not.toMatch(/"(image|thumbnail|gatewayUrl|metadataURI)"/);
      // The match says sealed in the service's own words, and as a state rather than a fault.
      expect(answer.result.best.picture, label).toEqual({ state: "sealed" });
      const carriesFlag = /"picture"\s*:\s*\{\s*"state"\s*:\s*"sealed"\s*\}/.test(text);
      if (carriesFlag) flagged += 1;
      detail.push(
        `${label.padEnd(24)} ${response.statusCode}, best ${answer.result.best.id.slice(0, 12)}... confidence ${answer.result.confidence.toFixed(3)}, keys ${Object.keys(answer).join(",")}, image or thumbnail address none, sealed flag ${carriesFlag ? "present" : "absent"}`,
      );
    }
    detail.push(`the exact answer, whole: ${exact.body.replace(/0x([0-9a-f]{10})[0-9a-f]{54}/g, "0x$1...")}`);

    expect(flagged).toBe(2);
    record({
      n: "4a",
      what: "POST /verify with a copy of a sealed passport the index holds",
      verdict:
        'PASS on the picture, no image, thumbnail or gateway address in either answer; PASS on the flag: the match carries picture {"state":"sealed"} in both answers, so an API or x402 caller is told the picture is sealed and not only the match',
      notCovered:
        "the web's verify card, which reads the flag itself and is tested in packages/web/test/sealed-verify.test.ts, and /verify/paid, which attaches the same fact through the same function and is tested in test/passportFacts.test.ts",
      detail,
    });
  }, 120_000);

  it("4b refuses a re-check for a sealed passport with 409 sealed, and queues nothing", async () => {
    const response = await indexed.inject({
      method: "POST",
      url: "/recheck/request",
      payload: { passportId: sealed.passportId },
      remoteAddress: "198.51.100.35",
    });
    const status = await indexed.inject({ method: "GET", url: `/recheck/status/${sealed.passportId}` });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "sealed", passportId: sealed.passportId });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(status.json().status).toBe("none");
    record({
      n: "4b",
      what: "POST /recheck/request for a sealed passport, its document read through the injected reader",
      verdict: `REFUSED, ${response.statusCode} sealed, no-store, and the queue still says ${status.json().status}`,
      notCovered: "a gateway that cannot be read, where the route queues the request and the runner refuses it later, by design",
      detail: [`answer ${response.body.replace(/0x([0-9a-f]{10})[0-9a-f]{54}/g, "0x$1...")}`],
    });
  }, 60_000);

  it("4c says unsealed on a copy of a passport its holder published, and queues its re-check", async () => {
    const copy = await verify(await sharp(opened.bytes).jpeg({ quality: 70 }).toBuffer());
    const asked = await indexed.inject({
      method: "POST",
      url: "/recheck/request",
      payload: { passportId: opened.passportId },
      remoteAddress: "198.51.100.36",
    });

    expect(copy.statusCode).toBe(200);
    expect(copy.json().result.best.id).toBe(opened.passportId);
    expect(copy.json().result.best.picture).toEqual({ state: "unsealed", at: UNSEALED_AT.toISOString() });
    expect(asked.statusCode).toBe(200);
    expect(asked.json()).toMatchObject({ passportId: opened.passportId, status: "pending" });
    record({
      n: "4c",
      what: "a sealed passport its holder has unsealed since (finding 5g), through /verify and /recheck/request",
      verdict: `PASS, the copy's match says unsealed with the record's time, and the re-check request is ${asked.statusCode} ${asked.json().status}, not 409 sealed`,
      notCovered: "the live Pinata listing and the gateway read behind the record, which are stubbed here and read live in production",
      detail: [
        `verify picture ${JSON.stringify(copy.json().result.best.picture)}`,
        `recheck answer ${asked.body.replace(/0x([0-9a-f]{10})[0-9a-f]{54}/g, "0x$1...")}`,
      ],
    });
  }, 60_000);
});
