// Covers the claim flow through the real server with Pinata answered at the fetch layer, the chain
// stood in for (chain time, the agent's owner, getPassport, ownerOf), Privy tokens signed by a test
// key set and Privy's user record served by a stand-in client, so the real embedded wallet selector
// runs: the deliverTo field shaped as the SDK sends it; P30 the prepare answer has the same shape
// for a Moolam user's address, a stranger's and none; a malformed deliverTo is refused naming the
// field only, before anything is pinned; P27 an offer appears only after the chain shows the
// passport under the platform's wallet; P28 Privy's spelling of the address meets the platform's;
// P31 the destination is the first embedded wallet and never a platform's; P32 an id from another
// address refuses the whole request; P33 a racing accept and refuse, one wins; P26 a refusal mutes
// the platform until the person unmutes, and a standing choice returns deliverNow to its key only;
// P34 deliveries lists only tickets the platform still holds, and failed is shown to the person;
// P37 a waiting entry carries the terms its own person accepted; P38 the per-person limit and the
// ceiling for everyone; the pepper missing closes every claim
// route and deliverTo; P29 no answer and no log line carries an address, in any spelling, or its hash.
// Does NOT cover Privy's real API, a real pin, a real Monad read, the SDK's worker sending a
// transfer, the web app's claims page, or a log written by anything but this process's logger.

import { createHash, randomBytes } from "node:crypto";
import fs, { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SignJWT, generateKeyPair } from "jose";
import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { makeImage } from "./helpers.js";

const APP_ID = vi.hoisted(() => {
  const id = "moolamtestapp0000009";
  process.env.PRIVY_APP_ID = id;
  process.env.PRIVY_APP_SECRET = "test-secret-not-a-real-privy-secret";
  process.env.PINATA_JWT = "test-token-not-a-real-pinata-jwt";
  process.env.PINATA_GATEWAY_URL = "https://moolam-test.mypinata.cloud/ipfs/";
  process.env.CLAIM_PEPPER = "5e".repeat(32);
  process.env.CLAIM_PEPPER_VERSION = "5";
  return id;
});

const stubs = vi.hoisted(() => ({
  passportExists: vi.fn(async () => false),
  users: new Map<string, unknown[]>(),
  chain: {
    now: 0n,
    owners: new Map<bigint, string>(),
    passports: new Map<string, unknown>(),
    holders: new Map<string, string>(),
  },
}));

vi.mock("../src/edit/registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/edit/registry.js")>()),
  passportExists: stubs.passportExists,
}));

vi.mock("../src/generate/privy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/generate/privy.js")>()),
  privy: () => ({
    users: () => ({
      _get: async (userId: string) => ({ id: userId, linked_accounts: stubs.users.get(userId) ?? [] }),
    }),
  }),
}));

vi.mock("../src/platform/chain.js", () => ({
  liveChain: () => ({
    now: async () => stubs.chain.now,
    agentOwner: async (agentId: bigint) => {
      const owner = stubs.chain.owners.get(agentId);
      if (owner === undefined) throw new Error("ERC721NonexistentToken");
      return owner;
    },
    passport: async (exactHash: string) => stubs.chain.passports.get(exactHash),
  }),
}));

const { buildServer } = await import("../src/server.js");
const { contentIdOf } = await import("../src/ipfs/pinata.js");
const { onboardingTypedData, recordMessage } = await import("../src/platforms/platforms.js");
const { prepareTypedData } = await import("../src/platform/signatures.js");
const { CLAIM_STATE_FILES } = await import("../src/stateDir.js");
const { claimStore, writeTicket, DEFAULT_CLAIM_CAPS } = await import("../src/claims/store.js");
const { emailHash } = await import("../src/claims/email.js");
const { previewReader } = await import("../src/claims/preview.js");

const UPLOAD_URL = "https://uploads.pinata.cloud/v3/files";
const AGENT_ID = 4242n;
const PEPPER = { secret: Buffer.from("5e".repeat(32), "hex"), version: "5" };
const THUMB_CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";
const SEEDED_METADATA = "ipfs://bafkreie7ohywtosou76tasm7j63yigtzxe7d5zqus4zu3j6oltvgtibeom";

const agentOwner = privateKeyToAccount(`0x${"41".repeat(32)}`);
const platformCreator = privateKeyToAccount(`0x${"42".repeat(32)}`);
const stranger = getAddress("0x5772a46ee0000000000000000000000000000005");
const ramWallet = getAddress("0xa11ce00000000000000000000000000000000011");
const beaWallet = getAddress("0xb0b0000000000000000000000000000000000022");

const KEY = randomBytes(32).toString("hex");
const KEY_HASH = `0x${createHash("sha256").update(Buffer.from(KEY, "hex")).digest("hex")}` as Hex;

const terms = { aiTraining: "notAllowed", aiGenerativeTraining: "notAllowed", aiInference: "allowed", dataMining: "unspecified", constraintInfo: "" };

const pins: Buffer[] = [];
let app: FastifyInstance;
let dir: string;
let signing: CryptoKey;
let verifying: CryptoKey;
let entry: unknown;
let seed = 500;
let address = 10;
let nextPassport = 0x9000;

function embedded(wallet: string) {
  return { type: "wallet", wallet_client_type: "privy", connector_type: "embedded", chain_type: "ethereum", address: wallet, verified_at: 1 };
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

function caller(): string {
  address += 1;
  return `198.18.${Math.floor(address / 250)}.${address % 250}`;
}

function sha256(bytes: Buffer): Hex {
  return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}

function multipart(fields: Record<string, string>, file: Buffer): { payload: Buffer; headers: Record<string, string> } {
  const boundary = "----moolamclaims";
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  chunks.push(
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="picture.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return { payload: Buffer.concat(chunks), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

/** A platform prepare with the deliverTo field exactly as the SDK sends it: one field of JSON. */
async function prepare(deliverTo: string | undefined, mode: "platform" | "cosign" = "platform", on: FastifyInstance = app) {
  const picture = await makeImage((seed += 1));
  const nonce = `0x${randomBytes(32).toString("hex")}` as Hex;
  const issuedAt = stubs.chain.now;
  const signature = await agentOwner.signTypedData(
    prepareTypedData({ mode: mode === "platform" ? 0 : 1, pictureHash: sha256(picture), platformId: KEY_HASH, nonce, issuedAt }),
  );
  const fields: Record<string, string> = {
    mode,
    title: "Harbour lights",
    nonce,
    issuedAt: issuedAt.toString(),
    signature,
    ...(deliverTo === undefined ? {} : { deliverTo }),
  };
  const body = multipart(fields, picture);
  return await on.inject({
    method: "POST",
    url: "/platform/prepare",
    payload: body.payload,
    headers: { ...body.headers, authorization: `Bearer ${KEY}` },
    remoteAddress: caller(),
  });
}

async function asPerson(subject: string, method: "GET" | "POST" | "DELETE", url: string, payload?: unknown, on: FastifyInstance = app) {
  return await on.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    headers: { authorization: `Bearer ${await token(subject)}` },
    remoteAddress: caller(),
  });
}

async function asPlatform(method: "GET" | "POST", url: string, on: FastifyInstance = app) {
  return await on.inject({ method, url, headers: { authorization: `Bearer ${KEY}` }, remoteAddress: caller() });
}

/** The chain shows this passport registered by the platform's wallet, held by `holder`. */
function onChain(passportId: string, metadataURI: string, holder: string = platformCreator.address): void {
  stubs.chain.passports.set(passportId, {
    creator: platformCreator.address,
    generatorAgentId: AGENT_ID,
    manifestHash: `0x${"77".repeat(32)}`,
    kind: 0,
    metadataURI,
    registeredAt: stubs.chain.now,
  });
  stubs.chain.holders.set(passportId, holder);
}

/** An open ticket for this address, written straight into the server's store and opened by its sweep. */
async function openTicket(email: string, on: FastifyInstance = app, folder: string = dir): Promise<{ ticketId: string; passportId: string }> {
  nextPassport += 1;
  const passportId = `0x${nextPassport.toString(16).padStart(64, "0")}`;
  const written = writeTicket(
    claimStore(path.join(folder, CLAIM_STATE_FILES.tickets)),
    {
      passportId,
      keyHash: KEY_HASH,
      platformName: "Acme Images",
      creatorWallet: platformCreator.address,
      verifiedBy: "email-code",
      emailHash: emailHash(email, PEPPER) as string,
      standing: undefined,
    },
    Number(stubs.chain.now),
    DEFAULT_CLAIM_CAPS,
  );
  if (!written.ok) throw new Error(written.reason);
  onChain(passportId, SEEDED_METADATA);
  await on.claimSweep();
  return { ticketId: written.value.ticketId, passportId };
}

/** What a JSON value looks like with every leaf replaced by its type. */
function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shapeOf);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, inner]) => [key, shapeOf(inner)]));
  }
  return typeof value;
}

const claimChain = {
  now: async () => stubs.chain.now,
  passport: async (id: Hex) => stubs.chain.passports.get(id) as never,
  ownerOf: async (id: Hex) => {
    const holder = stubs.chain.holders.get(id);
    if (holder === undefined) throw new Error("ERC721NonexistentToken");
    return getAddress(holder);
  },
};

const preview = previewReader(async (uri) => ({ name: uri === SEEDED_METADATA ? "Seeded" : "Harbour lights", thumbnail: `ipfs://${THUMB_CID}` }));

type ClaimOptions = NonNullable<NonNullable<Parameters<typeof buildServer>[0]>["claims"]>;

async function serverAt(folder: string, claims: ClaimOptions = {}, logger = false): Promise<FastifyInstance> {
  const server = await buildServer({
    source: { load: async () => [] },
    logger,
    prepare: { keys: verifying },
    platform: { keys: verifying, list: [entry], dir: folder },
    claims: { chain: claimChain, preview, ...claims },
  });
  await server.ready();
  return server;
}

/**
 * Everything the service logs while `work` runs, by both roads pino takes to the terminal: a plain
 * node run writes through process.stdout, and under this runner pino writes to descriptor 1 through
 * fs.write. The same capture attacks-sealed.test.ts uses.
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
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { result, logged: chunks.join("") };
  } finally {
    patched.write = realWrite;
    patched.writeSync = realWriteSync;
    stdout.mockRestore();
  }
}

describe("the claim routes", () => {
  beforeAll(async () => {
    const pair = await generateKeyPair("ES256", { extractable: true });
    signing = pair.privateKey;
    verifying = pair.publicKey;
    dir = mkdtempSync(path.join(tmpdir(), "moolam-claims-routes-"));
    stubs.chain.now = BigInt(Math.floor(Date.now() / 1000));
    stubs.chain.owners.set(AGENT_ID, agentOwner.address);
    stubs.users.set("did:privy:ram", [{ type: "email", address: "ram@example.com", verified_at: 1 }, embedded(ramWallet), embedded(stranger)]);
    stubs.users.set("did:privy:bea", [{ type: "google_oauth", email: "Bea@Gmail.com", verified_at: 1 }, embedded(beaWallet)]);
    stubs.users.set("did:privy:platform-wallet", [{ type: "email", address: "edge@example.com", verified_at: 1 }, embedded(platformCreator.address)]);
    stubs.users.set("did:privy:no-wallet", [{ type: "email", address: "nowallet@example.com", verified_at: 1 }]);

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
    entry = { ...unsigned, ownerSignature: await agentOwner.signTypedData(typed), creatorSignature: await platformCreator.signTypedData(typed) };

    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== UPLOAD_URL) throw new Error(`unexpected fetch to ${url}`);
      const bytes = Buffer.from(await ((init?.body as FormData).get("file") as File).arrayBuffer());
      pins.push(bytes);
      return new Response(JSON.stringify({ data: { cid: contentIdOf(bytes), size: bytes.length, network: "public" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    app = await serverAt(dir);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("mounts the claim routes and the deliveries route, and names them on /health", async () => {
    const health = (await app.inject({ method: "GET", url: "/health" })).json();
    expect(health.routes).toEqual(expect.arrayContaining(["platform/deliveries", "claims"]));
  });

  it("P30: answers a prepare for a Moolam user's address, a stranger's and none in the same shape", async () => {
    const known = await prepare(JSON.stringify({ email: " RAM@example.com", verifiedBy: "google" }));
    const unknown = await prepare(JSON.stringify({ email: "nobody-here@example.com", verifiedBy: "google" }));
    const none = await prepare(undefined);
    for (const response of [known, unknown, none]) {
      expect(response.statusCode).toBe(200);
      expect(response.json().deliverNow).toBeUndefined();
    }
    expect(shapeOf(known.json())).toEqual(shapeOf(none.json()));
    expect(shapeOf(unknown.json())).toEqual(shapeOf(none.json()));
    expect(known.body.toLowerCase()).not.toContain("ram@example.com");
  }, 120_000);

  it("refuses a malformed deliverTo with the field's name only, before anything is signed or pinned", async () => {
    pins.length = 0;
    const secret = "secret.person@example.com";
    const bad = [
      "not json",
      JSON.stringify({ email: secret }),
      JSON.stringify({ email: secret, verifiedBy: "facebook" }),
      JSON.stringify({ email: secret, verifiedBy: "google", name: "x" }),
      JSON.stringify({ email: `Secret Person <${secret}>`, verifiedBy: "google" }),
      JSON.stringify({ email: `${secret}‮`, verifiedBy: "google" }),
      JSON.stringify({ email: "x".repeat(3000), verifiedBy: "google" }),
    ];
    for (const deliverTo of bad) {
      const response = await prepare(deliverTo);
      expect(response.statusCode, deliverTo.slice(0, 30)).toBe(400);
      expect(response.json()).toEqual({ error: "deliverTo" });
    }
    const cosign = await prepare(JSON.stringify({ email: secret, verifiedBy: "google" }), "cosign");
    expect(cosign.statusCode).toBe(400);
    expect(cosign.json()).toEqual({ error: "deliverTo" });
    expect(pins).toHaveLength(0);
  }, 60_000);

  it("offers a ticket only once the chain shows it under the platform's wallet, to the matching address only, and delivers it", async () => {
    const prepared = await prepare(JSON.stringify({ email: "Ram@Example.com", verifiedBy: "google" }));
    expect(prepared.statusCode).toBe(200);
    const { exactHash, metadataURI } = prepared.json().passport as { exactHash: string; metadataURI: string };
    const offersFor = async (subject: string) => (await asPerson(subject, "GET", "/claims")).json().offers as { passportId: string }[];

    await app.claimSweep();
    expect((await offersFor("did:privy:ram")).map((one) => one.passportId)).not.toContain(exactHash);

    onChain(exactHash, metadataURI);
    stubs.chain.passports.set(exactHash, { ...(stubs.chain.passports.get(exactHash) as object), creator: stranger });
    await app.claimSweep();
    expect((await offersFor("did:privy:ram")).map((one) => one.passportId)).not.toContain(exactHash);

    onChain(exactHash, metadataURI);
    await app.claimSweep();
    const claims = await asPerson("did:privy:ram", "GET", "/claims");
    expect(claims.statusCode).toBe(200);
    expect(claims.headers["cache-control"]).toBe("no-store");
    const offer = (claims.json().offers as { ticketId: string; passportId: string }[]).find((one) => one.passportId === exactHash);
    expect(offer).toEqual({
      ticketId: expect.stringMatching(/^[0-9a-f]{32}$/),
      passportId: exactHash,
      platform: { name: "Acme Images", keyHash: KEY_HASH },
      verifiedBy: "google",
      preview: { title: "Harbour lights", image: `ipfs://${THUMB_CID}` },
      createdAt: Number(stubs.chain.now),
    });
    expect((await offersFor("did:privy:bea")).map((one) => one.passportId)).not.toContain(exactHash);
    const ticketId = (offer as { ticketId: string }).ticketId;

    const accepted = await asPerson("did:privy:ram", "POST", "/claims/accept", { ticketIds: [ticketId], terms, sendFuture: false });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ accepted: [ticketId], destination: ramWallet });

    const deliveries = await asPlatform("GET", "/platform/deliveries");
    expect(deliveries.json().deliveries).toContainEqual({ ticketId, passportId: exactHash, destination: ramWallet });

    stubs.chain.holders.set(exactHash, ramWallet);
    expect((await asPlatform("GET", "/platform/deliveries")).json().deliveries.map((one: { ticketId: string }) => one.ticketId)).not.toContain(ticketId);
    await app.claimSweep();
    const waiting = (await asPerson("did:privy:ram", "GET", "/claims")).json().waiting;
    expect(waiting).toContainEqual({ ticketId, passportId: exactHash, platform: { name: "Acme Images", keyHash: KEY_HASH }, state: "delivered", destination: ramWallet, terms });
  }, 120_000);

  it("P32: refuses a request naming another address's ticket whole, and changes neither", async () => {
    const rams = await openTicket("ram@example.com");
    const beas = await openTicket("bea@gmail.com");
    const mixed = await asPerson("did:privy:bea", "POST", "/claims/accept", { ticketIds: [beas.ticketId, rams.ticketId], terms, sendFuture: false });
    expect(mixed.statusCode).toBe(404);
    expect(mixed.json()).toEqual({ error: "not-found" });
    const refused = await asPerson("did:privy:bea", "POST", "/claims/refuse", { ticketIds: [rams.ticketId] });
    expect(refused.json()).toEqual({ error: "not-found" });
    expect((await asPerson("did:privy:bea", "GET", "/claims")).json().offers.map((one: { ticketId: string }) => one.ticketId)).toContain(beas.ticketId);
    expect((await asPerson("did:privy:ram", "GET", "/claims")).json().offers.map((one: { ticketId: string }) => one.ticketId)).toContain(rams.ticketId);

    for (const body of [{ ticketIds: [] }, { ticketIds: [rams.ticketId, rams.ticketId] }, { ticketIds: Array.from({ length: 33 }, () => randomBytes(16).toString("hex")) }, { ticketIds: ["nope"] }]) {
      const response = await asPerson("did:privy:ram", "POST", "/claims/refuse", body);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "ticketIds" });
    }
  });

  it("P33: of an accept and a refuse sent together, exactly one wins", async () => {
    const { ticketId } = await openTicket("ram@example.com");
    const [accept, refuse] = await Promise.all([
      asPerson("did:privy:ram", "POST", "/claims/accept", { ticketIds: [ticketId], terms, sendFuture: false }),
      asPerson("did:privy:ram", "POST", "/claims/refuse", { ticketIds: [ticketId] }),
    ]);
    try {
      expect([accept.statusCode, refuse.statusCode].sort()).toEqual([200, 409]);
      const loser = accept.statusCode === 409 ? accept : refuse;
      expect(loser.json()).toEqual({ error: "not-open" });
      const claims = (await asPerson("did:privy:ram", "GET", "/claims")).json();
      const waitingIds = claims.waiting.map((one: { ticketId: string }) => one.ticketId);
      expect(waitingIds.includes(ticketId)).toBe(accept.statusCode === 200);
    } finally {
      // Whichever request won, the tests after this one start with the platform unmuted.
      await asPerson("did:privy:ram", "POST", "/claims/unmute", { platformKeyHash: KEY_HASH });
    }
  });

  it("P26, P30: a standing choice returns deliverNow to its key for that address only, until it is cleared", async () => {
    const { ticketId } = await openTicket("bea@gmail.com");
    const accepted = await asPerson("did:privy:bea", "POST", "/claims/accept", { ticketIds: [ticketId], terms, sendFuture: true });
    expect(accepted.statusCode).toBe(200);
    const standing = (await asPerson("did:privy:bea", "GET", "/claims")).json().standing;
    expect(standing).toEqual([{ platform: { name: "Acme Images", keyHash: KEY_HASH }, destination: beaWallet }]);

    const hers = await prepare(JSON.stringify({ email: "bea@gmail.com", verifiedBy: "google" }));
    expect(hers.json().deliverNow).toBe(beaWallet);
    const someoneElse = await prepare(JSON.stringify({ email: "ram@example.com", verifiedBy: "google" }));
    expect(someoneElse.json().deliverNow).toBeUndefined();

    const cleared = await asPerson("did:privy:bea", "DELETE", `/claims/standing/${KEY_HASH}`);
    expect(cleared.json()).toEqual({ ok: true });
    expect((await prepare(JSON.stringify({ email: "bea@gmail.com", verifiedBy: "google" }))).json().deliverNow).toBeUndefined();
  }, 120_000);

  it("P26: a refusal is final and mutes that platform for the address until the person unmutes", async () => {
    const first = await openTicket("ram@example.com");
    const refused = await asPerson("did:privy:ram", "POST", "/claims/refuse", { ticketIds: [first.ticketId] });
    expect(refused.json()).toEqual({ refused: [first.ticketId] });
    const again = await asPerson("did:privy:ram", "POST", "/claims/accept", { ticketIds: [first.ticketId], terms, sendFuture: false });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: "not-open" });

    const later = await openTicket("ram@example.com");
    const muted = (await asPerson("did:privy:ram", "GET", "/claims")).json();
    expect(muted.muted).toEqual([{ platform: { name: "Acme Images", keyHash: KEY_HASH } }]);
    expect(muted.offers.map((one: { ticketId: string }) => one.ticketId)).not.toContain(later.ticketId);

    expect((await asPerson("did:privy:ram", "POST", "/claims/unmute", { platformKeyHash: KEY_HASH })).json()).toEqual({ ok: true });
    const shown = (await asPerson("did:privy:ram", "GET", "/claims")).json();
    expect(shown.muted).toEqual([]);
    expect(shown.offers.map((one: { ticketId: string }) => one.ticketId)).toContain(later.ticketId);
    expect(shown.offers.map((one: { ticketId: string }) => one.ticketId)).not.toContain(first.ticketId);
  });

  it("P31: the destination is Privy's first embedded wallet, never a platform's wallet, and never one the body names", async () => {
    const edge = await openTicket("edge@example.com");
    const toPlatform = await asPerson("did:privy:platform-wallet", "POST", "/claims/accept", { ticketIds: [edge.ticketId], terms, sendFuture: false });
    expect(toPlatform.statusCode).toBe(403);
    expect(toPlatform.json()).toEqual({ error: "destination" });

    const lonely = await openTicket("nowallet@example.com");
    const noWallet = await asPerson("did:privy:no-wallet", "POST", "/claims/accept", { ticketIds: [lonely.ticketId], terms, sendFuture: false });
    expect(noWallet.json()).toEqual({ error: "no-wallet" });

    const named = await asPerson("did:privy:edge", "POST", "/claims/accept", { ticketIds: [edge.ticketId], terms, sendFuture: false, destination: stranger });
    expect(named.statusCode).toBe(400);
    expect(named.json()).toEqual({ error: "body" });
    const badTerms = await asPerson("did:privy:ram", "POST", "/claims/accept", { ticketIds: [edge.ticketId], terms: { ...terms, constraintInfo: "x" }, sendFuture: false });
    expect(badTerms.json()).toEqual({ error: "terms" });
  });

  it("P37: a waiting entry carries exactly the terms its own person accepted, and never another person's", async () => {
    const rams = await openTicket("ram@example.com");
    const beas = await openTicket("bea@gmail.com");
    const ramTerms = { aiTraining: "constrained", aiGenerativeTraining: "notAllowed", aiInference: "allowed", dataMining: "constrained", constraintInfo: " ask at https://ram.example/ai " };
    const beaTerms = { aiTraining: "allowed", aiGenerativeTraining: "allowed", aiInference: "notAllowed", dataMining: "unspecified", constraintInfo: "" };
    expect((await asPerson("did:privy:ram", "POST", "/claims/accept", { ticketIds: [rams.ticketId], terms: ramTerms, sendFuture: false })).statusCode).toBe(200);
    expect((await asPerson("did:privy:bea", "POST", "/claims/accept", { ticketIds: [beas.ticketId], terms: beaTerms, sendFuture: false })).statusCode).toBe(200);

    const ramWaiting = (await asPerson("did:privy:ram", "GET", "/claims")).json().waiting as { ticketId: string; terms: unknown }[];
    const beaWaiting = (await asPerson("did:privy:bea", "GET", "/claims")).json().waiting as { ticketId: string; terms: unknown }[];
    expect(ramWaiting.find((one) => one.ticketId === rams.ticketId)?.terms).toEqual(ramTerms);
    expect(beaWaiting.find((one) => one.ticketId === beas.ticketId)?.terms).toEqual(beaTerms);
    expect(ramWaiting.map((one) => one.ticketId)).not.toContain(beas.ticketId);
    expect(beaWaiting.map((one) => one.ticketId)).not.toContain(rams.ticketId);
    expect(JSON.stringify(beaWaiting)).not.toContain("ram.example");
  });

  it("P34: lists only accepted tickets the platform still holds, and a failed one is shown to the person", async () => {
    const held = await openTicket("ram@example.com");
    const gone = await openTicket("ram@example.com");
    await asPerson("did:privy:ram", "POST", "/claims/accept", { ticketIds: [held.ticketId, gone.ticketId], terms, sendFuture: false });
    stubs.chain.holders.set(gone.passportId, stranger);
    const listed = (await asPlatform("GET", "/platform/deliveries")).json().deliveries.map((one: { ticketId: string }) => one.ticketId);
    expect(listed).toContain(held.ticketId);
    expect(listed).not.toContain(gone.ticketId);

    const failed = await asPlatform("POST", `/platform/deliveries/${held.ticketId}/failed`);
    expect(failed.json()).toEqual({ ticketId: held.ticketId, state: "failed" });
    expect((await asPlatform("POST", `/platform/deliveries/${held.ticketId}/failed`)).statusCode).toBe(409);
    expect((await asPlatform("POST", `/platform/deliveries/${randomBytes(16).toString("hex")}/failed`)).statusCode).toBe(404);
    expect((await asPlatform("POST", "/platform/deliveries/not-an-id/failed")).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/platform/deliveries", remoteAddress: caller() })).statusCode).toBe(401);
    const waiting = (await asPerson("did:privy:ram", "GET", "/claims")).json().waiting;
    expect(waiting).toContainEqual(expect.objectContaining({ ticketId: held.ticketId, state: "failed" }));
  });

  it("P38: meters each person, and the ceiling for everyone closes the routes at zero", async () => {
    const folder = mkdtempSync(path.join(tmpdir(), "moolam-claims-limits-"));
    const limited = await serverAt(path.join(folder, "a"), { limits: { perUserPerDay: 2 } });
    const closed = await serverAt(path.join(folder, "b"), { limits: { perDay: 0 } });
    try {
      expect((await asPerson("did:privy:ram", "GET", "/claims", undefined, limited)).statusCode).toBe(200);
      expect((await asPerson("did:privy:ram", "GET", "/claims", undefined, limited)).statusCode).toBe(200);
      const third = await asPerson("did:privy:ram", "GET", "/claims", undefined, limited);
      expect(third.statusCode).toBe(429);
      expect(third.json()).toEqual({ error: "limit" });
      expect((await asPerson("did:privy:bea", "GET", "/claims", undefined, limited)).statusCode).toBe(200);
      const ceiling = await asPerson("did:privy:bea", "GET", "/claims", undefined, closed);
      expect(ceiling.statusCode).toBe(429);
      expect(ceiling.json().error).toBe("global-limit");
    } finally {
      await limited.close();
      await closed.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("closes every claim route and refuses deliverTo when the pepper is missing", async () => {
    const folder = mkdtempSync(path.join(tmpdir(), "moolam-claims-closed-"));
    const closed = await serverAt(folder, { pepper: null });
    try {
      pins.length = 0;
      for (const [method, url, body] of [
        ["GET", "/claims", undefined],
        ["POST", "/claims/accept", { ticketIds: [randomBytes(16).toString("hex")], terms, sendFuture: false }],
        ["POST", "/claims/refuse", { ticketIds: [randomBytes(16).toString("hex")] }],
        ["POST", "/claims/unmute", { platformKeyHash: KEY_HASH }],
        ["DELETE", `/claims/standing/${KEY_HASH}`, undefined],
      ] as const) {
        const response = await asPerson("did:privy:ram", method, url, body, closed);
        expect(response.statusCode, url).toBe(503);
        expect(response.json()).toEqual({ error: "claims-unavailable" });
      }
      expect((await asPlatform("GET", "/platform/deliveries", closed)).json()).toEqual({ error: "claims-unavailable" });
      const refused = await prepare(JSON.stringify({ email: "ram@example.com", verifiedBy: "google" }), "platform", closed);
      expect(refused.statusCode).toBe(503);
      expect(refused.json()).toEqual({ error: "claims-unavailable" });
      expect(pins).toHaveLength(0);
      expect((await closed.inject({ method: "GET", url: "/health" })).json().routes).not.toContain("claims");
    } finally {
      await closed.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("P29: no answer and no log line carries an address, in any spelling, or its hash", async () => {
    const folder = mkdtempSync(path.join(tmpdir(), "moolam-claims-log-"));
    const spellings = [" Ram@Example.COM ", "ram@example.com", "Bea@Gmail.com", "bea@gmail.com", "secret.person@example.com"];
    const forbidden = new Set<string>();
    for (const spelling of spellings) {
      forbidden.add(spelling.trim().toLowerCase());
      const hash = emailHash(spelling, PEPPER) as string;
      forbidden.add(hash);
      forbidden.add(hash.slice(2));
    }
    const answers: string[] = [];
    const { logged } = await captureLog(async () => {
      const loud = await serverAt(folder, {}, true);
      try {
        const keep = (response: { body: string }) => answers.push(response.body);
        const prepared = await prepare(JSON.stringify({ email: spellings[0], verifiedBy: "google" }), "platform", loud);
        keep(prepared);
        keep(await prepare(JSON.stringify({ email: `Secret <${spellings[4]}>`, verifiedBy: "google" }), "platform", loud));
        keep(await prepare(JSON.stringify({ email: spellings[4], verifiedBy: "nobody" }), "platform", loud));
        const { exactHash, metadataURI } = prepared.json().passport as { exactHash: string; metadataURI: string };
        onChain(exactHash, metadataURI);
        const beas = await openTicket("bea@gmail.com", loud, folder);
        await loud.claimSweep();
        const listed = await asPerson("did:privy:ram", "GET", "/claims", undefined, loud);
        keep(listed);
        const ticketId = (listed.json().offers as { ticketId: string }[])[0]?.ticketId as string;
        keep(await asPerson("did:privy:ram", "POST", "/claims/accept", { ticketIds: [ticketId, beas.ticketId], terms, sendFuture: true }, loud));
        keep(await asPerson("did:privy:ram", "POST", "/claims/accept", { ticketIds: [ticketId], terms, sendFuture: true }, loud));
        keep(await asPerson("did:privy:bea", "POST", "/claims/refuse", { ticketIds: [beas.ticketId] }, loud));
        keep(await asPerson("did:privy:bea", "GET", "/claims", undefined, loud));
        keep(await asPlatform("GET", "/platform/deliveries", loud));
        keep(await prepare(JSON.stringify({ email: spellings[1], verifiedBy: "email-code" }), "platform", loud));
        keep(await asPerson("did:privy:ram", "GET", "/claims", undefined, loud));
      } finally {
        await loud.close();
      }
    });
    rmSync(folder, { recursive: true, force: true });
    expect(logged.length).toBeGreaterThan(0);
    expect(logged).toContain("claims: tickets accepted");
    expect(answers.join(" ")).toContain("deliverNow");
    const everything = `${logged} ${answers.join(" ")}`.toLowerCase();
    for (const value of forbidden) {
      expect(everything.includes(value.toLowerCase()), value.slice(0, 12)).toBe(false);
    }
  }, 120_000);
});
