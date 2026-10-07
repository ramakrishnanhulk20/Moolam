// Covers the platform routes end to end with Pinata answered at the fetch layer, the chain reads
// (chain time, ownerOf on the ERC-8004 registry, getPassport) and the duplicate check stubbed, and
// Privy tokens signed by a test key set with the wallet list stubbed: a request without a valid key
// costs nothing; P7 the per-key quota and the ceiling for every platform refuse before any work,
// and both are read from the environment; P19 a valid key with no agent signature, or with a
// stranger's, makes no manifest and no pin; a replayed PlatformPrepare and a second prepare of the
// same picture are refused; P18 a body naming another creator is refused; P9 a 257-byte or
// non-ASCII condition is refused at prepare; platform mode returns the digest hashPassport gives
// and the signed file whose sha256 is the passport id, and pins with cid_version v1 under the ids
// it computed, in a manifest that names the agent; co-sign mode hands back no signed file and pins
// nothing before /platform/sign;
// P2 a second wallet's open is refused with the agent still named; P5 a signature from a wallet
// other than ownerOf is refused and nothing is pinned; P3 a record edited on disk, or one whose state
// skipped a step, is refused and dropped; P12 a passed deadline is refused and never moves again;
// P13 "registered" only from a chain read of this very passport.
// Does NOT cover a real pin, a real Monad read, the remote Privy JWKS or Privy's user lookup, the
// registry accepting the digest (the fork tests in packages/sdk will), the co-sign page in the
// browser, or what reaches the log: the handle routes are mounted at log level silent, which a test
// with the logger off cannot observe.

import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Reader } from "@contentauth/c2pa-node";
import { SignJWT, generateKeyPair } from "jose";
import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { makeImage } from "./helpers.js";

const APP_ID = vi.hoisted(() => {
  const id = "moolamtestapp0000009";
  process.env.PRIVY_APP_ID = id;
  process.env.PRIVY_APP_SECRET = "test-secret-not-a-real-privy-secret";
  process.env.PINATA_JWT = "test-token-not-a-real-pinata-jwt";
  process.env.PINATA_GATEWAY_URL = "https://moolam-test.mypinata.cloud/ipfs/";
  // Numbers nothing else uses and above what this file spends, so the limits test below proves the
  // route read these rather than a default that happened to match.
  process.env.PLATFORM_PREPARES_PER_KEY_PER_DAY = "37";
  process.env.GLOBAL_PLATFORM_PREPARES_PER_DAY = "41";
  return id;
});

const stubs = vi.hoisted(() => ({
  embedManifest: vi.fn(),
  passportExists: vi.fn(async () => false),
  embeddedWallets: vi.fn(),
  chain: {
    now: 0n,
    owners: new Map<bigint, string>(),
    passports: new Map<string, unknown>(),
  },
}));

vi.mock("../src/c2pa.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/c2pa.js")>();
  stubs.embedManifest.mockImplementation(real.embedManifest);
  return { ...real, embedManifest: stubs.embedManifest };
});

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
    passport: async (exactHash: string) => stubs.chain.passports.get(exactHash),
  }),
}));

const { buildServer } = await import("../src/server.js");
const { contentIdOf } = await import("../src/ipfs/pinata.js");
const { passportDigest } = await import("../src/generate/eip712.js");
const { generatorDomain } = await import("../src/generate/generatorSigner.js");
const { onboardingTypedData, recordMessage } = await import("../src/platforms/platforms.js");
const { prepareTypedData } = await import("../src/platform/signatures.js");
const { handleHash } = await import("../src/platform/pending.js");
const { dailyQuota, fileQuotaStore } = await import("../src/generate/quota.js");
const { fileDayStore, globalDay } = await import("../src/limits/globalDay.js");
const { PLATFORM_STATE_FILES } = await import("../src/stateDir.js");

const UPLOAD_URL = "https://uploads.pinata.cloud/v3/files";
const AGENT_ID = 4242n;

const agentOwner = privateKeyToAccount(`0x${"31".repeat(32)}`);
const platformCreator = privateKeyToAccount(`0x${"32".repeat(32)}`);
const stranger = privateKeyToAccount(`0x${"33".repeat(32)}`);
const personA = getAddress("0xa11ce00000000000000000000000000000000001");
const personB = getAddress("0xb0b0000000000000000000000000000000000002");

const KEY = randomBytes(32).toString("hex");
const KEY_HASH = `0x${createHash("sha256").update(Buffer.from(KEY, "hex")).digest("hex")}` as Hex;

/** Every pin the stub took: the name, the cid_version it was sent with and the bytes. */
const pins: { name: string; cidVersion: string | null; bytes: Buffer }[] = [];

let app: FastifyInstance;
let dir: string;
let signing: CryptoKey;
let verifying: CryptoKey;
let seed = 100;
let address = 10;

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

function nonce(): Hex {
  return `0x${randomBytes(32).toString("hex")}`;
}

function sha256(bytes: Buffer): Hex {
  return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}

/** A fresh caller address, so no test meets the service-wide 60 a minute. */
function caller(): string {
  address += 1;
  return `203.0.113.${address}`;
}

async function signPrepare(
  signer: typeof agentOwner,
  mode: "platform" | "cosign",
  picture: Buffer,
  n: Hex,
  issuedAt: bigint,
): Promise<Hex> {
  return await signer.signTypedData(
    prepareTypedData({ mode: mode === "platform" ? 0 : 1, pictureHash: sha256(picture), platformId: KEY_HASH, nonce: n, issuedAt }),
  );
}

function multipart(fields: Record<string, string>, file: Buffer): { payload: Buffer; headers: Record<string, string> } {
  const boundary = "----moolamplatform";
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

interface PrepareAsk {
  mode: "platform" | "cosign";
  picture?: Buffer;
  signer?: typeof agentOwner | null;
  nonce?: Hex;
  issuedAt?: bigint;
  extra?: Record<string, string>;
  key?: string | null;
}

async function prepare(ask: PrepareAsk) {
  const picture = ask.picture ?? (await makeImage((seed += 1)));
  const n = ask.nonce ?? nonce();
  const issuedAt = ask.issuedAt ?? stubs.chain.now;
  const signer = ask.signer === undefined ? agentOwner : ask.signer;
  const fields: Record<string, string> = {
    mode: ask.mode,
    title: "Harbour lights",
    nonce: n,
    issuedAt: issuedAt.toString(),
    ...(signer === null ? {} : { signature: await signPrepare(signer, ask.mode, picture, n, issuedAt) }),
    ...ask.extra,
  };
  const body = multipart(fields, picture);
  const key = ask.key === undefined ? KEY : ask.key;
  return await app.inject({
    method: "POST",
    url: "/platform/prepare",
    payload: body.payload,
    headers: { ...body.headers, ...(key === null ? {} : { authorization: `Bearer ${key}` }) },
    remoteAddress: caller(),
  });
}

async function openRecord(handle: string, subject: string) {
  return await app.inject({
    method: "GET",
    url: `/platform/record/${handle}`,
    headers: { authorization: `Bearer ${await token(subject)}` },
    remoteAddress: caller(),
  });
}

async function status(handle: string) {
  return await app.inject({
    method: "GET",
    url: `/platform/status/${handle}`,
    headers: { authorization: `Bearer ${KEY}` },
    remoteAddress: caller(),
  });
}

async function sign(handle: string, digest: Hex, signer: typeof agentOwner = agentOwner) {
  return await app.inject({
    method: "POST",
    url: `/platform/sign/${handle}`,
    payload: { signature: await signer.sign({ hash: digest }) },
    headers: { authorization: `Bearer ${KEY}` },
    remoteAddress: caller(),
  });
}

/** The passport in an answer, back in the struct hashPassport reads. */
function inputFrom(passport: Record<string, string | number>) {
  return {
    exactHash: passport.exactHash as Hex,
    parentId: passport.parentId as Hex,
    creator: passport.creator as Hex,
    generatorAgentId: BigInt(passport.generatorAgentId as string),
    phash: BigInt(passport.phash as string),
    blockhash256: passport.blockhash256 as Hex,
    manifestHash: passport.manifestHash as Hex,
    kind: passport.kind as 0,
    fingerprintVersion: passport.fingerprintVersion as number,
    metadataURI: passport.metadataURI as string,
    deadline: BigInt(passport.deadline as string),
  };
}

function recordFile(handle: string): string {
  return path.join(dir, "platform-pending", `${handleHash(handle).slice(2)}.json`);
}

describe("the platform routes", () => {
  beforeAll(async () => {
    const pair = await generateKeyPair("ES256", { extractable: true });
    signing = pair.privateKey;
    verifying = pair.publicKey;
    dir = mkdtempSync(path.join(tmpdir(), "moolam-platform-"));
    stubs.chain.now = BigInt(Math.floor(Date.now() / 1000));
    stubs.chain.owners.set(AGENT_ID, agentOwner.address);
    stubs.embeddedWallets.mockImplementation(async (_client: unknown, userId: string) =>
      userId === "did:privy:person-a" ? [personA] : userId === "did:privy:person-b" ? [personB] : [],
    );

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
    writeFileSync(path.join(dir, "list.json"), JSON.stringify([entry]));

    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== UPLOAD_URL) throw new Error(`unexpected fetch to ${url}`);
      const form = init?.body as FormData;
      const bytes = Buffer.from(await (form.get("file") as File).arrayBuffer());
      pins.push({ name: String(form.get("name")), cidVersion: form.get("cid_version") as string | null, bytes });
      return new Response(JSON.stringify({ data: { cid: contentIdOf(bytes), size: bytes.length, network: "public" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    app = await buildServer({
      source: { load: async () => [] },
      logger: false,
      prepare: { keys: verifying },
      platform: { keys: verifying, list: [entry], dir },
    });
    await app.ready();
  });

  beforeEach(() => {
    pins.length = 0;
    stubs.embedManifest.mockClear();
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("answers 401 to a request with no key or a key it never issued, and does no work", async () => {
    for (const key of [null, randomBytes(32).toString("hex"), "not-a-key"]) {
      const response = await prepare({ mode: "platform", key });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "unauthorized" });
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    expect(stubs.embedManifest).not.toHaveBeenCalled();
    expect(pins).toHaveLength(0);
  });

  it("P19: a valid key with no agent signature, or a stranger's, makes no manifest, no pin and no record", async () => {
    const unsigned = await prepare({ mode: "cosign", signer: null });
    expect(unsigned.statusCode).toBe(401);
    expect(unsigned.json().error).toBe("agent-signature-required");

    const strangers = await prepare({ mode: "platform", signer: stranger });
    expect(strangers.statusCode).toBe(403);
    expect(strangers.json().error).toBe("agent-signature-refused");

    const stale = await prepare({ mode: "platform", issuedAt: stubs.chain.now - 601n });
    expect(stale.statusCode).toBe(403);
    expect(stale.json().error).toBe("prepare-expired");

    expect(stubs.embedManifest).not.toHaveBeenCalled();
    expect(pins).toHaveLength(0);
    expect(JSON.stringify([unsigned.json(), strangers.json(), stale.json()])).not.toContain(KEY);
  });

  it("P18: refuses a platform-mode body naming another creator or agent, and a co-sign body naming any creator", async () => {
    const other = await prepare({ mode: "platform", extra: { creator: stranger.address } });
    expect(other.statusCode).toBe(403);
    expect(other.json()).toMatchObject({ error: "platform-mismatch", field: "creator" });

    const agent = await prepare({ mode: "platform", extra: { agentId: "7" } });
    expect(agent.json()).toMatchObject({ error: "platform-mismatch", field: "agentId" });

    const cosign = await prepare({ mode: "cosign", extra: { wallet: personA } });
    expect(cosign.json()).toMatchObject({ error: "platform-mismatch", field: "wallet" });
    expect(stubs.embedManifest).not.toHaveBeenCalled();
  });

  it("P9: refuses a 257-byte, a non-ASCII or a padded condition at prepare, before anything is signed", async () => {
    for (const constraintInfo of ["x".repeat(257), "ask me ©", " ask me"]) {
      const response = await prepare({
        mode: "platform",
        extra: { training: JSON.stringify({ aiTraining: "constrained", constraintInfo }) },
      });
      expect(response.statusCode, constraintInfo.slice(0, 12)).toBe(400);
      expect(response.json().error).toContain("constraintInfo");
    }
    expect(stubs.embedManifest).not.toHaveBeenCalled();
    expect(pins).toHaveLength(0);
  });

  it("platform mode: the digest is the one hashPassport gives, and every pin is v1 under the id computed first", async () => {
    const picture = await makeImage(7);
    const training = { aiTraining: "constrained", constraintInfo: "licence at https://acme.example/ai" };
    const response = await prepare({ mode: "platform", picture, extra: { training: JSON.stringify(training) } });

    expect(response.statusCode).toBe(200);
    const answer = response.json();
    expect(answer.passport.creator).toBe(platformCreator.address);
    expect(answer.passport.generatorAgentId).toBe(AGENT_ID.toString());
    expect(answer.passport.kind).toBe(0);
    expect(BigInt(answer.passport.deadline)).toBe(stubs.chain.now + 1800n);
    expect(answer.digest).toBe(passportDigest(inputFrom(answer.passport), generatorDomain()));
    expect(answer.training).toEqual({ ...training, standard: "cawg.training-mining/1.1" });

    expect(pins).toHaveLength(4);
    for (const pin of pins) {
      expect(pin.cidVersion).toBe("v1");
    }
    const byCid = new Map(pins.map((pin) => [contentIdOf(pin.bytes), pin.bytes]));
    for (const role of ["image", "thumbnail", "manifest", "metadata"]) {
      expect(byCid.has(answer.files[role].cid), role).toBe(true);
    }
    expect(answer.passport.metadataURI).toBe(`ipfs://${answer.files.metadata.cid}`);
    const image = byCid.get(answer.files.image.cid) as Buffer;
    expect(sha256(image)).toBe(answer.passport.exactHash);
    const handed = Buffer.from(answer.signedFile.bytes, "base64");
    expect(sha256(handed)).toBe(answer.passport.exactHash);
    expect(answer.signedFile).toMatchObject({ type: "image/jpeg", sha256: answer.passport.exactHash });
    expect(answer.signedFile.name).toMatch(/\.jpg$/);
    expect(handed.equals(image)).toBe(true);
    expect(answer.files.image.bytes).toBe(handed.length);
    const metadata = JSON.parse((byCid.get(answer.files.metadata.cid) as Buffer).toString("utf8"));
    expect(metadata.image).toBe(`ipfs://${answer.files.image.cid}`);
    expect(metadata.generator.agentId).toBe(AGENT_ID.toString());
    expect(metadata.training.constraintInfo).toBe(training.constraintInfo);

    const reader = await Reader.fromAsset({ buffer: image, mimeType: "image/jpeg" });
    const created = (reader?.getActive()?.assertions ?? [])
      .filter((one) => one.label?.startsWith("c2pa.actions"))
      .flatMap((one) => (one.data as { actions: Record<string, unknown>[] }).actions)
      .find((one) => one.action === "c2pa.created");
    expect(created?.digitalSourceType).toBe("http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia");
    expect(created?.softwareAgent).toMatchObject({
      name: "Acme Images generator",
      "site.moolam.erc8004": { agentId: AGENT_ID.toString() },
    });
  }, 60_000);

  it("refuses a replayed PlatformPrepare and a second prepare of the same picture inside the window", async () => {
    const picture = await makeImage(8);
    const n = nonce();
    const first = await prepare({ mode: "platform", picture, nonce: n });
    expect(first.statusCode).toBe(200);
    pins.length = 0;
    stubs.embedManifest.mockClear();

    const replay = await prepare({ mode: "platform", picture, nonce: n });
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toEqual({ error: "replayed" });

    const again = await prepare({ mode: "cosign", picture });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: "same-picture" });
    expect(stubs.embedManifest).not.toHaveBeenCalled();
    expect(pins).toHaveLength(0);
  }, 60_000);

  it("co-sign mode pins nothing before /platform/sign, refuses a second wallet and a wrong signer, then pins under the computed ids", async () => {
    const prepared = await prepare({ mode: "cosign" });
    expect(prepared.statusCode).toBe(200);
    const { handle, files } = prepared.json();
    expect(handle).toMatch(/^[0-9a-f]{32}$/);
    expect(prepared.json().digest).toBeUndefined();
    expect(prepared.json().signedFile).toBeUndefined();
    expect(prepared.json().passport.creator).toBeUndefined();
    expect(pins).toHaveLength(0);

    const opened = await openRecord(handle, "did:privy:person-a");
    expect(opened.statusCode).toBe(200);
    const record = opened.json();
    expect(record.state).toBe("creator-set");
    expect(record.passport.creator).toBe(personA);
    expect(record.digest).toBe(passportDigest(inputFrom(record.passport), generatorDomain()));

    const second = await openRecord(handle, "did:privy:person-b");
    expect(second.statusCode).toBe(403);
    expect(second.json()).toMatchObject({ error: "creator-mismatch", agentId: AGENT_ID.toString() });

    const again = await openRecord(handle, "did:privy:person-a");
    expect(again.json().passport.deadline).toBe(record.passport.deadline);

    const wrong = await sign(handle, record.digest, stranger);
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error).toBe("agent-signature-refused");
    expect((await status(handle)).json().state).toBe("creator-set");
    expect(pins).toHaveLength(0);

    const signed = await sign(handle, record.digest);
    expect(signed.statusCode).toBe(200);
    expect(signed.json().state).toBe("signed");
    expect(pins).toHaveLength(4);
    expect(pins.every((pin) => pin.cidVersion === "v1")).toBe(true);
    expect(new Set(pins.map((pin) => contentIdOf(pin.bytes)))).toEqual(
      new Set(["image", "thumbnail", "manifest", "metadata"].map((role) => files[role].cid)),
    );

    expect((await status(handle)).json().state).toBe("signed");
    stubs.chain.passports.set(record.passport.exactHash, {
      creator: personB,
      generatorAgentId: AGENT_ID,
      manifestHash: record.passport.manifestHash,
      kind: 0,
      metadataURI: record.passport.metadataURI,
      registeredAt: stubs.chain.now,
    });
    expect((await status(handle)).json()).toMatchObject({ state: "failed" });
    stubs.chain.passports.set(record.passport.exactHash, {
      creator: personA,
      generatorAgentId: AGENT_ID,
      manifestHash: record.passport.manifestHash,
      kind: 0,
      metadataURI: record.passport.metadataURI,
      registeredAt: stubs.chain.now,
    });
    expect((await status(handle)).json().state).toBe("registered");
  }, 60_000);

  it("P3: a record edited on disk, or one whose state skipped a step, is refused and dropped", async () => {
    const edited = (await prepare({ mode: "cosign" })).json().handle as string;
    const opened = await openRecord(edited, "did:privy:person-a");
    expect(opened.statusCode).toBe(200);
    const file = recordFile(edited);
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    onDisk.fields.metadataURI = `ipfs://${contentIdOf(Buffer.from("another document"))}`;
    writeFileSync(file, JSON.stringify(onDisk));

    const refused = await sign(edited, opened.json().digest);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe("record-refused");
    expect(readdirSync(path.dirname(file))).not.toContain(path.basename(file));
    expect((await status(edited)).statusCode).toBe(404);

    const skipped = (await prepare({ mode: "cosign" })).json().handle as string;
    const skippedFile = recordFile(skipped);
    const awaiting = JSON.parse(readFileSync(skippedFile, "utf8"));
    writeFileSync(skippedFile, JSON.stringify({ ...awaiting, state: "signed" }));
    const skippedOpen = await openRecord(skipped, "did:privy:person-a");
    expect(skippedOpen.statusCode).toBe(409);
    expect(skippedOpen.json().error).toBe("record-refused");

    // Before a creator exists there is no signing digest yet, so the digest stored at creation is
    // what catches an edit.
    const waiting = (await prepare({ mode: "cosign" })).json().handle as string;
    const waitingFile = recordFile(waiting);
    const fields = JSON.parse(readFileSync(waitingFile, "utf8"));
    fields.fields.phash = "1";
    writeFileSync(waitingFile, JSON.stringify(fields));
    const waitingOpen = await openRecord(waiting, "did:privy:person-a");
    expect(waitingOpen.statusCode).toBe(409);
    expect(readdirSync(path.dirname(waitingFile))).not.toContain(path.basename(waitingFile));
    expect(pins).toHaveLength(0);
  }, 60_000);

  it("P7: the per-key quota and the ceiling for every platform stop a prepare before any work", async () => {
    const main = app;
    const entry = (await import("../src/platforms/platforms.js")).platformListSchema.parse(
      JSON.parse(readFileSync(path.join(dir, "list.json"), "utf8")),
    );
    const servers: FastifyInstance[] = [];
    try {
      for (const limits of [{ perKeyPerDay: 1 }, { perDay: 0 }]) {
        const limited = await buildServer({
          source: { load: async () => [] },
          logger: false,
          platform: { keys: verifying, list: entry, dir: path.join(dir, `limits-${servers.length}`), limits },
        });
        await limited.ready();
        servers.push(limited);
      }
      app = servers[0] as FastifyInstance;
      expect((await prepare({ mode: "platform" })).statusCode).toBe(200);
      pins.length = 0;
      stubs.embedManifest.mockClear();
      const quota = await prepare({ mode: "platform" });
      expect(quota.statusCode).toBe(429);
      expect(quota.json().error).toBe("quota");

      app = servers[1] as FastifyInstance;
      const ceiling = await prepare({ mode: "platform" });
      expect(ceiling.statusCode).toBe(429);
      expect(ceiling.json().error).toBe("global-limit");
      expect(stubs.embedManifest).not.toHaveBeenCalled();
      expect(pins).toHaveLength(0);
    } finally {
      app = main;
      for (const server of servers) await server.close();
    }
  }, 60_000);

  it("the per-key quota and the ceiling for every platform come from the environment and reach the prepare route", async () => {
    const main = app;
    const entry = (await import("../src/platforms/platforms.js")).platformListSchema.parse(
      JSON.parse(readFileSync(path.join(dir, "list.json"), "utf8")),
    );
    const keyDir = path.join(dir, "env-quota");
    const spentByKey = dailyQuota(1_000, { store: fileQuotaStore(path.join(keyDir, PLATFORM_STATE_FILES.quota)) });
    for (let n = 0; n < 37; n += 1) spentByKey.take(KEY_HASH);
    const dayDir = path.join(dir, "env-day");
    const spentToday = globalDay({ prepares: 1_000, generations: 0, edits: 0, unseals: 0, links: 0 }, Date.now, {
      store: fileDayStore(path.join(dayDir, PLATFORM_STATE_FILES.dayCeiling)),
    });
    for (let n = 0; n < 41; n += 1) spentToday.tryTake("prepares");

    const servers: FastifyInstance[] = [];
    try {
      for (const folder of [keyDir, dayDir]) {
        const limited = await buildServer({ source: { load: async () => [] }, logger: false, platform: { keys: verifying, list: entry, dir: folder } });
        await limited.ready();
        servers.push(limited);
      }
      app = servers[0] as FastifyInstance;
      const quota = await prepare({ mode: "platform" });
      expect(quota.statusCode).toBe(429);
      expect(quota.json()).toMatchObject({ error: "quota", quota: { used: 37, limit: 37 } });

      app = servers[1] as FastifyInstance;
      const ceiling = await prepare({ mode: "platform" });
      expect(ceiling.statusCode).toBe(429);
      expect(ceiling.json()).toMatchObject({ error: "global-limit", quota: { used: 41, limit: 41 } });
      expect(stubs.embedManifest).not.toHaveBeenCalled();
      expect(pins).toHaveLength(0);
    } finally {
      app = main;
      for (const server of servers) await server.close();
    }
  }, 60_000);

  it("P12: a passed deadline is refused, and the record never moves again", async () => {
    const handle = (await prepare({ mode: "cosign" })).json().handle as string;
    const record = (await openRecord(handle, "did:privy:person-a")).json();
    const started = stubs.chain.now;
    try {
      stubs.chain.now = BigInt(record.passport.deadline) + 1n;
      const late = await sign(handle, record.digest);
      expect(late.statusCode).toBe(410);
      expect(late.json()).toMatchObject({ error: "expired", agentId: AGENT_ID.toString() });
      expect(pins).toHaveLength(0);

      stubs.chain.now = started;
      expect((await status(handle)).json().state).toBe("expired");
      expect((await sign(handle, record.digest)).statusCode).toBe(410);
      expect((await openRecord(handle, "did:privy:person-a")).statusCode).toBe(410);
      expect(pins).toHaveLength(0);
    } finally {
      stubs.chain.now = started;
    }
  }, 60_000);
});
