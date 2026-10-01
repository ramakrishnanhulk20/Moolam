// Covers the look-alike warning a prepare answer carries before anyone signs (WO-275a). It is a
// read that succeeded or it says it could not check (L19): "found" names the earliest earlier
// passport by another creator and another edit family, "yours" the creator's own when nobody
// else's is there, "none" the second the index was current to, and "unchecked" a stale index,
// fingerprints that could not be taken, or wallets that could not be read in time. A passport of
// the same second is never earlier (L10). A stranger's title arrives as one plain line of at most
// 120 code points, the id by the one pattern, the date from the chain record (L20). POST /prepare
// carries the field on its answer, with Pinata, the registry read and the signer's key load
// stubbed, and the wallet and title reads handed in.
// Does NOT cover the live Privy wallet read or a real gateway title read, and does not run
// /platform/prepare end to end: its two creator rules (the platform's wallet, nobody in co-sign
// mode) are the same function with a different wallet list, covered here at unit level.

import { SignJWT, generateKeyPair } from "jose";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { plainTitle } from "../src/claims/preview.js";
import { fingerprint } from "../src/fingerprint.js";
import { HammingIndex } from "../src/index.js";
import { contentIdOf } from "../src/ipfs/pinata.js";
import { PRESIGN_READ_MS, lookalikeBeforeSigning, type PresignReaders } from "../src/lookalike/presign.js";
import type { FingerprintPair } from "../src/lookalike/search.js";
import { buildServer, type IndexCopy } from "../src/server.js";
import type { PassportSource } from "../src/source/PassportSource.js";
import type { Hex, IndexState, PassportRecord } from "../src/types.js";
import { blockhashWithBits, idFrom, makeImage } from "./helpers.js";

const APP_ID = vi.hoisted(() => {
  const id = "moolamtestapp0000002";
  process.env.PRIVY_APP_ID = id;
  process.env.PINATA_JWT = "test-token-not-a-real-pinata-jwt";
  process.env.PINATA_GATEWAY_URL = "https://moolam-test.mypinata.cloud/ipfs/";
  return id;
});

const stubs = vi.hoisted(() => ({ ensureSigner: vi.fn(), passportExists: vi.fn() }));

vi.mock("../src/c2pa.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/c2pa.js")>()),
  ensureSigner: stubs.ensureSigner,
}));

vi.mock("../src/edit/registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/edit/registry.js")>()),
  passportExists: stubs.passportExists,
}));

const NOW = 1_790_000_000;
const MINE = "0x1111111111111111111111111111111111111111" as Hex;
const THEIRS = "0x2222222222222222222222222222222222222222" as Hex;
const ZERO_BLOCKHASH = blockhashWithBits(0);
const PAIR: FingerprintPair = { phash: 0n, blockhash: ZERO_BLOCKHASH };
const PRINTABLE = /^[\p{L}\p{M}\p{N}\p{P}\p{S} ]+$/u;

function passport(byte: number, registeredAt: number, extra: Partial<PassportRecord> = {}): PassportRecord {
  return {
    id: idFrom(byte),
    phash: 0n,
    blockhash: ZERO_BLOCKHASH,
    creator: THEIRS,
    parentId: null,
    registeredAt,
    metadataURI: `ipfs://bafkdoc${byte}`,
    ...extra,
  };
}

function copyOf(records: PassportRecord[], state: IndexState = { loadedAt: NOW - 30, stale: false }): IndexCopy {
  const passports = new Map(records.map((record) => [record.id, record]));
  return {
    index: new HammingIndex(records),
    lookupExact: (id) => passports.get(id),
    state: () => state,
    passports,
    covers: () => true,
  };
}

function readers(wallets: readonly string[] | Error, title = "A lighthouse"): PresignReaders & { titles: string[] } {
  const titles: string[] = [];
  return {
    titles,
    creators: async () => {
      if (wallets instanceof Error) throw wallets;
      return wallets;
    },
    titleOf: async (uri) => {
      titles.push(uri);
      return title;
    },
  };
}

describe("L19: the prepare answer's look-alike state", () => {
  it("names the earliest earlier passport by another creator, with its title and its chain registration second", async () => {
    const copy = copyOf([passport(3, NOW - 50), passport(1, NOW - 900), passport(2, NOW - 400, { phash: 7n })]);
    const reads = readers([MINE]);

    const answer = await lookalikeBeforeSigning(copy, [PAIR], reads, NOW);

    expect(answer).toEqual({ state: "found", passportId: idFrom(1), title: "A lighthouse", registeredAt: NOW - 900 });
    expect(reads.titles).toEqual(["ipfs://bafkdoc1"]);
  });

  it("answers yours when every earlier look-alike is the creator's own, an edit within their own family included", async () => {
    const original = passport(1, NOW - 900, { creator: MINE, phash: 0xffff_0000n });
    const editByAnother = passport(2, NOW - 400, { creator: THEIRS, parentId: original.id });
    const ownCopy = passport(3, NOW - 300, { creator: MINE });

    const answer = await lookalikeBeforeSigning(copyOf([original, editByAnother, ownCopy]), [PAIR], readers([MINE]), NOW);

    expect(answer).toEqual({ state: "yours", passportId: idFrom(2) });
  });

  it("names another creator's earlier passport over the creator's own, as the chain mark would", async () => {
    const copy = copyOf([passport(1, NOW - 900, { creator: MINE }), passport(2, NOW - 400, { phash: 3n })]);

    const answer = await lookalikeBeforeSigning(copy, [PAIR], readers([MINE]), NOW);

    expect(answer).toMatchObject({ state: "found", passportId: idFrom(2), registeredAt: NOW - 400 });
  });

  it("answers none with the second the index was current to, and reads no wallet or title", async () => {
    const far = passport(1, NOW - 900, { phash: (1n << 11n) - 1n });
    const reads = readers(new Error("must not be asked"));

    expect(await lookalikeBeforeSigning(copyOf([far], { loadedAt: NOW - 30, stale: false, indexedTo: 9, indexedAt: NOW - 12 }), [PAIR], reads, NOW)).toEqual({
      state: "none",
      indexAt: NOW - 12,
    });
    expect(await lookalikeBeforeSigning(copyOf([]), [PAIR], reads, NOW)).toEqual({ state: "none", indexAt: NOW - 30 });
    expect(reads.titles).toEqual([]);
  });

  it("answers unchecked for a stale index, fingerprints that could not be taken, or wallets that failed or never came", async () => {
    const match = [passport(1, NOW - 900)];

    expect(await lookalikeBeforeSigning(copyOf(match, { loadedAt: NOW - 3_600, stale: true }), [PAIR], readers([MINE]), NOW)).toEqual({ state: "unchecked" });
    expect(await lookalikeBeforeSigning(copyOf(match), undefined, readers([MINE]), NOW)).toEqual({ state: "unchecked" });
    expect(await lookalikeBeforeSigning(copyOf(match), [PAIR], readers(new Error("privy down")), NOW)).toEqual({ state: "unchecked" });

    vi.useFakeTimers();
    try {
      const waiting = lookalikeBeforeSigning(copyOf(match), [PAIR], { creators: () => new Promise(() => undefined), titleOf: async () => "" }, NOW);
      await vi.advanceTimersByTimeAsync(PRESIGN_READ_MS);
      expect(await waiting).toEqual({ state: "unchecked" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("L10: a passport of the same second is not earlier", () => {
  it("answers none for a look-alike registered in the very second the picture is being signed", async () => {
    const answer = await lookalikeBeforeSigning(copyOf([passport(1, NOW)]), [PAIR], readers([MINE]), NOW);
    expect(answer).toEqual({ state: "none", indexAt: NOW - 30 });
    expect(await lookalikeBeforeSigning(copyOf([passport(1, NOW - 1)]), [PAIR], readers([MINE]), NOW)).toMatchObject({ state: "found" });
  });
});

describe("L20: a stranger's text is text", () => {
  const hostile = `‮evil\u0000 title\nsecond line​<script>alert(1)</script>${"x".repeat(300)}`;

  it("cuts a hostile title to one printable line of at most 120 code points", async () => {
    const answer = await lookalikeBeforeSigning(copyOf([passport(1, NOW - 900)]), [PAIR], readers([MINE], hostile), NOW);

    expect(answer.state).toBe("found");
    const title = (answer as { title: string }).title;
    expect([...title].length).toBeLessThanOrEqual(120);
    expect(title).toMatch(PRINTABLE);
    expect(title).not.toMatch(/[\u0000-\u001f​‮]/u);
    expect(title.startsWith("evil title second line")).toBe(true);
  });

  it("answers an empty title when nothing printable is there, the read failed, or the name is not text", async () => {
    expect(plainTitle("\u0000‮\n\t")).toBe("");
    expect(plainTitle(42)).toBe("");
    expect(plainTitle(`${"🌊".repeat(130)}`)).toBe("🌊".repeat(120));

    const failing: PresignReaders = { creators: async () => [MINE], titleOf: async () => Promise.reject(new Error("gateway 504")) };
    expect(await lookalikeBeforeSigning(copyOf([passport(1, NOW - 900)]), [PAIR], failing, NOW)).toMatchObject({ state: "found", title: "" });
  });

  it("sends the id by the one passport id pattern, lower-cased, and the date from the chain record", async () => {
    const shouting = passport(1, NOW - 900, { id: `0x${"AB".repeat(32)}` as Hex });

    const answer = await lookalikeBeforeSigning(copyOf([shouting]), [PAIR], readers([MINE]), NOW);

    expect(answer).toEqual({ state: "found", passportId: `0x${"ab".repeat(32)}`, title: "A lighthouse", registeredAt: NOW - 900 });
  });
});

describe("POST /prepare carries the look-alike state", () => {
  const UPLOAD_URL = "https://uploads.pinata.cloud/v3/files";
  let signing: CryptoKey;
  let verifying: CryptoKey;
  let image: Buffer;
  let servers: FastifyInstance[] = [];

  beforeAll(async () => {
    stubs.ensureSigner.mockResolvedValue(undefined);
    stubs.passportExists.mockResolvedValue(false);
    const pair = await generateKeyPair("ES256", { extractable: true });
    signing = pair.privateKey;
    verifying = pair.publicKey;
    image = await makeImage(41);

    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== UPLOAD_URL) return await realFetch(input, init);
      const form = init?.body as FormData;
      const bytes = Buffer.from(await (form.get("file") as File).arrayBuffer());
      return new Response(JSON.stringify({ data: { cid: contentIdOf(bytes), size: bytes.length, network: "public" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
  });

  afterEach(async () => {
    await Promise.all(servers.map(async (server) => await server.close()));
    servers = [];
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

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

  async function studio(source: PassportSource, walletsOf: (userId: string) => Promise<readonly string[]>): Promise<FastifyInstance> {
    const server = await buildServer({
      source,
      logger: false,
      prepare: { keys: verifying, lookalike: { walletsOf, titleOf: async () => "Night harbour‮" } },
    });
    await server.ready();
    servers.push(server);
    return server;
  }

  async function prepare(server: FastifyInstance, user: string): Promise<Record<string, unknown>> {
    const boundary = "----moolamlookalike";
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nHarbour\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nhuman\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="h.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      image,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const response = await server.inject({
      method: "POST",
      url: "/prepare",
      payload,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${await token(user)}` },
      remoteAddress: "203.0.113.70",
    });
    expect(response.statusCode).toBe(200);
    return response.json() as Record<string, unknown>;
  }

  it("answers found, yours, none and unchecked from the index the request reads", async () => {
    const print = await fingerprint(image);
    const earlier: PassportRecord = {
      id: idFrom(0x51),
      phash: print.phash,
      blockhash: print.blockhash,
      creator: THEIRS,
      parentId: null,
      registeredAt: Math.floor(Date.now() / 1000) - 3_600,
      metadataURI: "ipfs://bafkearlier",
    };
    const seeded: PassportSource = { load: async () => [earlier] };
    const walletsOf = async (userId: string): Promise<readonly string[]> => {
      if (userId === "did:privy:broken") throw new Error("privy down");
      return userId === "did:privy:owner" ? [THEIRS] : [MINE];
    };
    const server = await studio(seeded, walletsOf);

    expect((await prepare(server, "did:privy:stranger")).lookalike).toEqual({
      state: "found",
      passportId: earlier.id,
      title: "Night harbour",
      registeredAt: earlier.registeredAt,
    });
    expect((await prepare(server, "did:privy:owner")).lookalike).toEqual({ state: "yours", passportId: earlier.id });
    expect((await prepare(server, "did:privy:broken")).lookalike).toEqual({ state: "unchecked" });

    const empty = await studio({ load: async () => [] }, walletsOf);
    const none = (await prepare(empty, "did:privy:stranger")).lookalike as { state: string; indexAt: number };
    expect(none.state).toBe("none");
    expect(none.indexAt).toBe(empty.verifier.indexState().loadedAt);
  }, 120_000);
});
