// Covers the two routes Chainlink's nodes read during a look-alike run (WO-275a). The candidates
// route answers only passports registered strictly before asOf within the shared thresholds,
// oldest first by the shared rule, at most three, the earliest always among them, one place per
// fingerprint however many copies carry it (L10, L11, L16). Two asks with the same asOf get the
// same bytes; an index not loaded through asOf answers not-ready; anything malformed is refused
// 400 before a scan (L16). The backlog lists the passports still waiting for a network verdict or,
// for an original, a look-alike record, that the workflow can check, oldest first, and says
// not-ready rather than a partial list; unset settings say nothing (L14's list side). Neither
// route reads the chain or a gateway while a request waits, and both sit under the service's 60 a
// minute per address and a ceiling of their own (L18). The look-alike records come from
// LookalikeChecked events read by the background refresh, counted only at or after activation,
// and the network verdict from the index's own attestation rows. Once the index serves its own
// Lookalike rows (WO-276) they replace the chain scan, which stands in only while the index has no
// such entity and is asked again after ten minutes; an index that served them and then fails a read
// leaves the backlog not-ready.
// Does NOT cover the live index, a real RPC or the gateway: the index is a stub source or a local
// mock GraphQL server, the chain a stub, the documents a stub reader. The prepare warning is
// test/lookalike-presign.test.ts, the rule file itself test/lookalike-rule.test.ts.

import { createServer, type Server } from "node:http";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HammingIndex } from "../src/index.js";
import { NETWORK_RECEIVER, type BacklogSettings } from "../src/lookalike/backlog.js";
import { INDEX_ABSENT_RETRY_MS, lookalikeKnowledge } from "../src/lookalike/knowledge.js";
import { envioLookalikeReader, type IndexedLookalikes, type LookalikeIndexReader } from "../src/lookalike/indexRecords.js";
import { LEDGER_CHUNK_BLOCKS, type LedgerChain, type LedgerLog } from "../src/lookalike/ledger.js";
import { UnreachableTarget } from "../src/net/safeFetch.js";
import { buildServer } from "../src/server.js";
import { EnvioSource } from "../src/source/EnvioSource.js";
import type { PassportSource } from "../src/source/PassportSource.js";
import type { Hex, PassportRecord } from "../src/types.js";
import { blockhashWithBits, idFrom } from "./helpers.js";

const NOW = 1_790_000_000;
const ACTIVATION = 1_789_000_000;
const RECEIVER = "0x7777777777777777777777777777777777777777" as Hex;
const OTHER = "0x2222222222222222222222222222222222222222" as Hex;
const ZERO_BLOCKHASH = blockhashWithBits(0);

let app: FastifyInstance | undefined;
let running: Server | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await app?.close();
  app = undefined;
  if (running !== undefined) {
    await new Promise<void>((resolve) => running?.close(() => resolve()));
    running = undefined;
  }
});

/** A pHash with `bits` low bits set, so its distance from 0 is exactly `bits`. */
function phashWithBits(bits: number): bigint {
  return (1n << BigInt(bits)) - 1n;
}

function passport(byte: number, registeredAt: number, extra: Partial<PassportRecord> = {}): PassportRecord {
  return {
    id: idFrom(byte),
    phash: 0n,
    blockhash: ZERO_BLOCKHASH,
    creator: OTHER,
    parentId: null,
    registeredAt,
    metadataURI: `ipfs://bafkdoc${byte}`,
    ...extra,
  };
}

/** A source whose indexer had read through the block at `through`, with the chain head at the same second. */
function indexedThrough(records: PassportRecord[], through = NOW): PassportSource {
  return {
    load: async () => records,
    loadWithProgress: async () => ({
      records,
      progress: { block: 100_000, blockTime: through, headTime: through, syncing: false },
    }),
  };
}

async function serve(
  records: PassportRecord[],
  options: {
    through?: number;
    settings?: BacklogSettings;
    readDocument?: (uri: string) => Promise<unknown>;
    chain?: LedgerChain;
    ceilings?: { candidates?: number; backlog?: number };
    index?: LookalikeIndexReader;
  } = {},
): Promise<FastifyInstance> {
  app = await buildServer({
    source: indexedThrough(records, options.through),
    logger: false,
    index: { refreshMs: 0, clock: () => NOW * 1000 },
    lookalikes: {
      settings: options.settings ?? {},
      clock: () => NOW * 1000,
      ...(options.index === undefined ? {} : { index: options.index }),
      ...(options.readDocument === undefined ? {} : { readDocument: options.readDocument }),
      ...(options.chain === undefined ? {} : { chain: options.chain }),
      ...(options.ceilings === undefined ? {} : { ceilings: options.ceilings }),
    },
  });
  await app.ready();
  return app;
}

async function ask(
  server: FastifyInstance,
  body: unknown,
  remoteAddress = "198.51.100.10",
): Promise<{ status: number; body: string; json: Record<string, unknown> }> {
  const response = await server.inject({
    method: "POST",
    url: "/lookalikes/candidates",
    payload: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json" },
    remoteAddress,
  });
  return { status: response.statusCode, body: response.body, json: response.json() };
}

async function backlog(
  server: FastifyInstance,
  query: string,
  remoteAddress = "198.51.100.20",
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await server.inject({ method: "GET", url: `/lookalikes/backlog?${query}`, remoteAddress });
  return { status: response.statusCode, json: response.json() };
}

const ONE_PAIR = [{ phash: "0x0000000000000000", blockhash: ZERO_BLOCKHASH }];

describe("POST /lookalikes/candidates", () => {
  it("L16 and L11: names only passports strictly before asOf within 10 and 40 bits, oldest first, at most three, the earliest always first", async () => {
    const server = await serve([
      // The earliest sits exactly on both thresholds, the furthest a match can be, and still leads.
      passport(1, 100, { phash: phashWithBits(10), blockhash: blockhashWithBits(40) }),
      passport(2, 200),
      passport(3, 300, { phash: phashWithBits(2) }),
      passport(4, 400, { blockhash: blockhashWithBits(5) }),
      passport(5, 50, { phash: phashWithBits(11) }),
      passport(6, 60, { blockhash: blockhashWithBits(41) }),
      passport(7, 500, { phash: phashWithBits(1) }),
    ]);

    const answer = await ask(server, { fingerprints: ONE_PAIR, asOf: 500 });

    expect(answer.status).toBe(200);
    expect(answer.json).toEqual({ status: "ok", candidates: [idFrom(1), idFrom(2), idFrom(3)] });
  });

  it("L10: never names a passport registered in the same second as asOf, and orders a same-second pair by id", async () => {
    const server = await serve([passport(9, 300), passport(8, 300, { phash: phashWithBits(1) })]);

    expect((await ask(server, { fingerprints: ONE_PAIR, asOf: 300 })).json).toEqual({ status: "ok", candidates: [] });
    expect((await ask(server, { fingerprints: ONE_PAIR, asOf: 301 })).json).toEqual({
      status: "ok",
      candidates: [idFrom(8), idFrom(9)],
    });
  });

  it("L16: gives a pile of copies of one fingerprint one place, named by its first registration", async () => {
    const copies = [10, 11, 12, 13, 14].map((byte, at) => passport(byte, 100 + at));
    const server = await serve([
      ...copies,
      passport(20, 300, { phash: phashWithBits(3) }),
      passport(21, 400, { blockhash: blockhashWithBits(9) }),
    ]);

    const answer = await ask(server, { fingerprints: ONE_PAIR, asOf: 1_000 });

    expect(answer.json).toEqual({ status: "ok", candidates: [idFrom(10), idFrom(20), idFrom(21)] });
  });

  it("L16: searches every pair sent, such as a picture's turns, and names each passport once", async () => {
    const turned = phashWithBits(30) << 20n;
    const server = await serve([passport(30, 100, { phash: turned }), passport(31, 200)]);

    const answer = await ask(server, {
      fingerprints: [...ONE_PAIR, { phash: `0x${turned.toString(16).padStart(16, "0")}`, blockhash: ZERO_BLOCKHASH }, ...ONE_PAIR],
      asOf: 1_000,
    });

    expect(answer.json).toEqual({ status: "ok", candidates: [idFrom(30), idFrom(31)] });
  });

  it("L16: answers two asks with the same asOf in the same bytes, whoever asks", async () => {
    const server = await serve([passport(1, 100), passport(2, 200, { phash: phashWithBits(4) })]);
    const body = { fingerprints: ONE_PAIR, asOf: 900 };

    const first = await ask(server, body, "198.51.100.1");
    const second = await ask(server, body, "203.0.113.9");

    expect(first.status).toBe(200);
    expect(second.body).toBe(first.body);
  });

  it("L16: answers not-ready, with no list, while the index is not loaded through asOf", async () => {
    const server = await serve([passport(1, 100)], { through: 1_000 });

    expect((await ask(server, { fingerprints: ONE_PAIR, asOf: 1_001 })).json).toEqual({ status: "not-ready" });
    expect((await ask(server, { fingerprints: ONE_PAIR, asOf: 1_000 })).json).toEqual({
      status: "ok",
      candidates: [idFrom(1)],
    });
  });

  it("L16: refuses a malformed body with 400 before any scan", async () => {
    const server = await serve([passport(1, 100)]);
    const scan = vi.spyOn(HammingIndex.prototype, "rowsWithin");
    const pair = ONE_PAIR[0] as { phash: string; blockhash: string };
    const bad: unknown[] = [
      "{not json",
      {},
      { fingerprints: ONE_PAIR },
      { fingerprints: [], asOf: 100 },
      { fingerprints: Array.from({ length: 9 }, () => pair), asOf: 100 },
      { fingerprints: [{ ...pair, phash: "0x000000000000000" }], asOf: 100 },
      { fingerprints: [{ ...pair, blockhash: `${ZERO_BLOCKHASH}00` }], asOf: 100 },
      { fingerprints: [{ ...pair, extra: 1 }], asOf: 100 },
      { fingerprints: ONE_PAIR, asOf: 100, n: 3 },
      { fingerprints: ONE_PAIR, asOf: 100.5 },
      { fingerprints: ONE_PAIR, asOf: "100" },
      { fingerprints: ONE_PAIR, asOf: 0 },
      { fingerprints: ONE_PAIR, asOf: NOW + 61 },
    ];

    for (const body of bad) {
      const answer = await ask(server, body);
      expect(answer.status, JSON.stringify(body)).toBe(400);
    }
    expect(scan).not.toHaveBeenCalled();
    // A minute ahead of this host is still a question; no index is loaded that far, so it is not-ready.
    expect((await ask(server, { fingerprints: ONE_PAIR, asOf: NOW + 60 })).json).toEqual({ status: "not-ready" });
    expect((await ask(server, { fingerprints: ONE_PAIR, asOf: 500 })).status).toBe(200);
    expect(scan).toHaveBeenCalledTimes(1);
  });
});

/** A chain whose block n was mined at second BASE + n, with these LookalikeChecked logs at these blocks. */
function ledgerChain(logs: (LedgerLog & { block: bigint })[], head = 20_000n) {
  const BASE = BigInt(ACTIVATION) - 18_000n;
  const calls = { blocks: 0, logs: [] as { from: bigint; to: bigint }[], failLogs: false };
  const chain: LedgerChain = {
    getBlockNumber: async () => head,
    getBlock: async ({ blockNumber }) => {
      calls.blocks += 1;
      return { timestamp: BASE + blockNumber };
    },
    getLogs: async ({ fromBlock, toBlock }) => {
      if (calls.failLogs) throw new Error("rpc refused");
      calls.logs.push({ from: fromBlock, to: toBlock });
      return logs.filter((log) => log.block >= fromBlock && log.block <= toBlock);
    },
  };
  return { chain, calls };
}

function checked(passportId: Hex, executedAt: number, block: bigint, extra: Partial<LedgerLog> = {}) {
  return { address: RECEIVER, block, args: { passportId, executedAt: BigInt(executedAt) }, ...extra };
}

const PUBLIC_DOC = { name: "a picture", thumbnail: "ipfs://bafkthumb" };

/** Documents by address: public and naming a picture unless listed here. */
function documents(special: Record<string, unknown> = {}) {
  const reads: string[] = [];
  const read = async (uri: string): Promise<unknown> => {
    reads.push(uri);
    const document = special[uri];
    if (document instanceof Error) throw document;
    return document ?? PUBLIC_DOC;
  };
  return { read, reads };
}

describe("GET /lookalikes/backlog", () => {
  const BOTH: BacklogSettings = { activation: ACTIVATION, receiver: RECEIVER };

  /** The waiting room: who lacks what, which documents can be checked, and one record per state. */
  function waitingRoom(): PassportRecord[] {
    return [
      passport(1, 100, { networkVerdict: false }),
      passport(2, 90, { networkVerdict: true }),
      passport(0x0e, 150, { networkVerdict: true }),
      passport(4, 140, { networkVerdict: true, parentId: idFrom(1) }),
      passport(5, 120, { networkVerdict: false }),
      passport(6, 130, { networkVerdict: false }),
      passport(0x0b, 150, { networkVerdict: false }),
      passport(8, 500, { networkVerdict: false }),
      passport(9, 160, { networkVerdict: true }),
    ];
  }
  const SPECIAL = {
    "ipfs://bafkdoc5": { name: "sealed", sealed: true },
    "ipfs://bafkdoc6": { name: "no picture" },
  };
  const RECORDS = [
    checked(idFrom(2), ACTIVATION + 10, 18_050n),
    // Before activation: it does not count, so passport 9 still waits for one.
    checked(idFrom(9), ACTIVATION - 10, 18_060n),
  ];

  it("lists what still waits and can be checked, oldest first by the shared rule then id, before asOf only", async () => {
    const docs = documents(SPECIAL);
    const { chain, calls } = ledgerChain(RECORDS);
    const server = await serve(waitingRoom(), { settings: BOTH, readDocument: docs.read, chain });

    expect((await backlog(server, "asOf=500&n=7")).json).toEqual({ status: "not-ready" });
    await server.lookalikes.refresh(server.verifier.snapshot().passports);

    expect((await backlog(server, "asOf=500&n=7")).json).toEqual({
      status: "ok",
      passports: [idFrom(1), idFrom(0x0b), idFrom(0x0e), idFrom(9)],
    });
    expect((await backlog(server, "asOf=500&n=2")).json).toEqual({ status: "ok", passports: [idFrom(1), idFrom(0x0b)] });
    expect((await backlog(server, "asOf=150&n=7")).json).toEqual({ status: "ok", passports: [idFrom(1)] });
    // The scan started at the first block at or after activation and never read more than 100 blocks at once.
    expect(calls.logs[0]?.from).toBe(18_000n);
    expect(calls.logs.every((range) => range.to - range.from + 1n <= LEDGER_CHUNK_BLOCKS)).toBe(true);
  });

  it("L18: reads no document, block or log while a request waits", async () => {
    const docs = documents(SPECIAL);
    const { chain, calls } = ledgerChain(RECORDS);
    const server = await serve(waitingRoom(), { settings: BOTH, readDocument: docs.read, chain });
    await server.lookalikes.refresh(server.verifier.snapshot().passports);
    const before = { documents: docs.reads.length, blocks: calls.blocks, logs: calls.logs.length };
    const fetching = vi.spyOn(globalThis, "fetch");

    await backlog(server, "asOf=500&n=7");
    await ask(server, { fingerprints: ONE_PAIR, asOf: 500 });

    expect({ documents: docs.reads.length, blocks: calls.blocks, logs: calls.logs.length }).toEqual(before);
    expect(fetching).not.toHaveBeenCalled();
  });

  it("says not-ready rather than a partial list while the look-alike records have not caught up", async () => {
    const { chain, calls } = ledgerChain(RECORDS);
    calls.failLogs = true;
    const server = await serve(waitingRoom(), { settings: BOTH, readDocument: documents(SPECIAL).read, chain });
    await server.lookalikes.refresh(server.verifier.snapshot().passports);

    expect((await backlog(server, "asOf=500&n=7")).json).toEqual({ status: "not-ready" });

    calls.failLogs = false;
    await server.lookalikes.refresh(server.verifier.snapshot().passports);
    expect((await backlog(server, "asOf=500&n=7")).json).toMatchObject({ status: "ok" });
  });

  it("says not-ready while the index is not loaded through asOf, or cannot say whether a verdict landed", async () => {
    const docs = documents(SPECIAL);
    const late = await serve(waitingRoom(), { through: 400, settings: { activation: ACTIVATION }, readDocument: docs.read });
    await late.lookalikes.refresh(late.verifier.snapshot().passports);
    expect((await backlog(late, "asOf=401&n=7")).json).toEqual({ status: "not-ready" });
    expect((await backlog(late, "asOf=400&n=7")).json).toEqual({ status: "ok", passports: [idFrom(1), idFrom(0x0b)] });
    await late.close();

    const unknown = await serve([passport(1, 100)], { settings: { activation: ACTIVATION }, readDocument: docs.read });
    await unknown.lookalikes.refresh(unknown.verifier.snapshot().passports);
    expect((await backlog(unknown, "asOf=500&n=7")).json).toEqual({ status: "not-ready" });
  });

  it("uses only the settings that are set, and with neither set lists nothing", async () => {
    const docs = documents(SPECIAL);
    const verdictsOnly = await serve(waitingRoom(), { settings: { activation: ACTIVATION }, readDocument: docs.read });
    await verdictsOnly.lookalikes.refresh(verdictsOnly.verifier.snapshot().passports);
    expect((await backlog(verdictsOnly, "asOf=500&n=7")).json).toEqual({ status: "ok", passports: [idFrom(1), idFrom(0x0b)] });
    await verdictsOnly.close();

    const neither = await serve(waitingRoom(), { settings: {}, readDocument: docs.read });
    await neither.lookalikes.refresh(neither.verifier.snapshot().passports);
    expect((await backlog(neither, "asOf=500&n=7")).json).toEqual({ status: "ok", passports: [] });
    await neither.close();

    const receiverOnly = await serve(waitingRoom(), { settings: { receiver: RECEIVER }, readDocument: docs.read });
    await receiverOnly.lookalikes.refresh(receiverOnly.verifier.snapshot().passports);
    expect((await backlog(receiverOnly, "asOf=500&n=7")).json).toEqual({ status: "ok", passports: [] });
  });

  it("leaves out a passport whose document read failed and reads it again on a later refresh", async () => {
    const docs = documents({ ...SPECIAL, "ipfs://bafkdoc1": new UnreachableTarget("gateway answered 504") });
    const server = await serve(waitingRoom(), { settings: { activation: ACTIVATION }, readDocument: docs.read });
    await server.lookalikes.refresh(server.verifier.snapshot().passports);

    expect((await backlog(server, "asOf=500&n=7")).json).toEqual({ status: "ok", passports: [idFrom(0x0b)] });
    expect(docs.reads.filter((uri) => uri === "ipfs://bafkdoc1")).toHaveLength(1);
  });

  it("refuses a malformed query with 400", async () => {
    const server = await serve(waitingRoom(), { settings: { activation: ACTIVATION } });
    for (const query of ["asOf=500", "n=3", "asOf=500&n=0", "asOf=500&n=8", "asOf=abc&n=1", "asOf=500&n=1&x=1", "asOf=500&asOf=501&n=1", `asOf=${NOW + 61}&n=1`]) {
      expect((await backlog(server, query)).status, query).toBe(400);
    }
  });
});

describe("L18: the look-alike routes are bounded", () => {
  it("meets the service's 60 a minute per address on the 61st ask", async () => {
    const server = await serve([passport(1, 100)]);
    const statuses: number[] = [];
    for (let at = 0; at < 61; at += 1) {
      statuses.push((await ask(server, { fingerprints: ONE_PAIR, asOf: 500 }, "198.51.100.77")).status);
    }

    expect(statuses.slice(0, 60).every((status) => status === 200)).toBe(true);
    expect(statuses[60]).toBe(429);
    expect((await ask(server, { fingerprints: ONE_PAIR, asOf: 500 }, "198.51.100.78")).status).toBe(200);
  });

  it("refuses everyone past each route's own ceiling for the minute", async () => {
    const server = await serve([passport(1, 100)], { ceilings: { candidates: 2, backlog: 1 } });

    expect((await ask(server, { fingerprints: ONE_PAIR, asOf: 500 }, "198.51.100.1")).status).toBe(200);
    expect((await ask(server, { fingerprints: ONE_PAIR, asOf: 500 }, "198.51.100.2")).status).toBe(200);
    const third = await ask(server, { fingerprints: ONE_PAIR, asOf: 500 }, "198.51.100.3");
    expect(third.status).toBe(429);
    expect(third.json).toEqual({ error: "route-limit" });

    expect((await backlog(server, "asOf=500&n=1", "198.51.100.4")).status).toBe(200);
    expect((await backlog(server, "asOf=500&n=1", "198.51.100.5")).status).toBe(429);
  });
});

describe("the backlog's two sources of knowledge", () => {
  it("reads whether the network wrote a verdict from the index's attestation rows from 0x0d69 at or after activation", async () => {
    const asked: string[] = [];
    const server = createServer((request, reply) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        asked.push((JSON.parse(Buffer.concat(chunks).toString("utf8")) as { query: string }).query);
        const row = (byte: number, network?: unknown) => ({
          id: idFrom(byte),
          phash: "0",
          blockhash: ZERO_BLOCKHASH,
          creator: { id: OTHER },
          registeredAt: "100",
          metadataURI: "ipfs://bafkdoc",
          ...(network === undefined ? {} : { network }),
        });
        const body = { data: { Passport: [row(1, [{ at: String(ACTIVATION) }]), row(2, []), row(3), row(4, "junk")] } };
        reply.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    running = server;
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/graphql`;

    const records = await new EnvioSource({ url, network: { receiver: NETWORK_RECEIVER, activation: ACTIVATION } }).load();
    expect(records.map((record) => record.networkVerdict)).toEqual([true, false, undefined, undefined]);
    expect(asked[0]).toContain(`network: attestations(where: { receiver: { _eq: "${NETWORK_RECEIVER}" }, at: { _gte: "${ACTIVATION}" } }, limit: 1)`);

    await new EnvioSource({ url }).load();
    expect(asked[1]).not.toContain("network:");
  });

  it("counts a LookalikeChecked record only from this receiver, not removed, and at or after activation", async () => {
    const docs = documents();
    const { chain } = ledgerChain([
      checked(idFrom(1), ACTIVATION, 18_100n),
      checked(idFrom(2), ACTIVATION + 5, 18_200n, { address: "0x9999999999999999999999999999999999999999" }),
      checked(idFrom(3), ACTIVATION + 5, 18_300n, { removed: true }),
      checked(idFrom(4), ACTIVATION - 1, 18_400n),
      checked(idFrom(5), ACTIVATION + 5, 17_900n),
    ]);
    const server = await serve(
      [1, 2, 3, 4, 5].map((byte) => passport(byte, 100 + byte, { networkVerdict: true })),
      { settings: { activation: ACTIVATION, receiver: RECEIVER }, readDocument: docs.read, chain },
    );
    await server.lookalikes.refresh(server.verifier.snapshot().passports);

    // Passport 5's record sits before the activation block, which the scan never reads.
    expect((await backlog(server, "asOf=500&n=7")).json).toEqual({
      status: "ok",
      passports: [idFrom(2), idFrom(3), idFrom(4), idFrom(5)],
    });
  });
});

describe("the index's Lookalike rows replace the chain scan", () => {
  const BOTH: BacklogSettings = { activation: ACTIVATION, receiver: RECEIVER };
  const originals = (): PassportRecord[] => [1, 2, 3].map((byte) => passport(byte, 100 + byte, { networkVerdict: true }));

  /** An index reader that answers `next` and counts how often it was asked. */
  function indexReader(next: () => IndexedLookalikes) {
    const asked: number[] = [];
    const read: LookalikeIndexReader = async (activation) => {
      asked.push(activation);
      return next();
    };
    return { read, asked };
  }

  it("reads the records from the index once it serves them, and never scans the chain", async () => {
    const { chain, calls } = ledgerChain([checked(idFrom(1), ACTIVATION + 5, 18_100n)]);
    const { read, asked } = indexReader(() => ({ kind: "rows", newest: new Map([[idFrom(2), ACTIVATION + 9]]) }));
    const server = await serve(originals(), { settings: BOTH, readDocument: documents().read, chain, index: read });
    await server.lookalikes.refresh(server.verifier.snapshot().passports);

    // Passport 2 has its record in the index; the chain's record for passport 1 was never read.
    expect((await backlog(server, "asOf=500&n=7")).json).toEqual({ status: "ok", passports: [idFrom(1), idFrom(3)] });
    expect(asked).toEqual([ACTIVATION]);
    expect(calls.logs).toEqual([]);
    expect(calls.blocks).toBe(0);
  });

  it("scans the chain while the index has no Lookalike entity, and asks the index again after ten minutes", async () => {
    let now = NOW * 1000;
    const { chain, calls } = ledgerChain([checked(idFrom(1), ACTIVATION + 5, 18_100n)]);
    let answer: IndexedLookalikes = { kind: "absent" };
    const { read, asked } = indexReader(() => answer);
    const knowledge = lookalikeKnowledge({ settings: BOTH, readDocument: documents().read, chain, index: read, clock: () => now });
    const passports = new Map(originals().map((record) => [record.id, record]));

    await knowledge.refresh(passports);
    expect(knowledge.view().records?.newestAt(idFrom(1))).toBe(ACTIVATION + 5);
    expect(calls.logs.length).toBeGreaterThan(0);

    now += INDEX_ABSENT_RETRY_MS - 1;
    await knowledge.refresh(passports);
    expect(asked).toHaveLength(1);

    answer = { kind: "rows", newest: new Map([[idFrom(3), ACTIVATION + 1]]) };
    now += 1;
    const scansBefore = calls.logs.length;
    await knowledge.refresh(passports);
    expect(asked).toHaveLength(2);
    expect(knowledge.view().records?.newestAt(idFrom(3))).toBe(ACTIVATION + 1);
    expect(knowledge.view().records?.newestAt(idFrom(1))).toBeUndefined();
    await knowledge.refresh(passports);
    expect(calls.logs.length).toBe(scansBefore);
  });

  it("says not-ready once an index that served the rows fails a read, never an older list", async () => {
    let answer: IndexedLookalikes = { kind: "rows", newest: new Map([[idFrom(2), ACTIVATION + 9]]) };
    const { read } = indexReader(() => answer);
    const { chain, calls } = ledgerChain([]);
    const server = await serve(originals(), { settings: BOTH, readDocument: documents().read, chain, index: read });
    await server.lookalikes.refresh(server.verifier.snapshot().passports);
    expect((await backlog(server, "asOf=500&n=7")).json).toMatchObject({ status: "ok" });

    answer = { kind: "failed", reason: "the index answered 502" };
    await server.lookalikes.refresh(server.verifier.snapshot().passports);
    expect((await backlog(server, "asOf=500&n=7")).json).toEqual({ status: "not-ready" });
    expect(calls.logs).toEqual([]);
  });

  it("reads the rows page by page, keeps only records at or after activation, and tells a missing entity from a failed read", async () => {
    const pages: unknown[] = [];
    const answers: unknown[] = [];
    const fetcher = (async (_url: string, init?: RequestInit) => {
      pages.push(JSON.parse(String(init?.body)));
      const next = answers.shift();
      if (next instanceof Response) return next;
      return new Response(JSON.stringify(next), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const reader = envioLookalikeReader("https://index.example/v1/graphql", fetcher);

    const full = Array.from({ length: 500 }, (_unused, at) => ({ id: idFrom(at % 200), executedAt: String(ACTIVATION + at) }));
    answers.push({ data: { Lookalike: full } }, { data: { Lookalike: [{ id: idFrom(0xfe), executedAt: ACTIVATION - 1 }] } });
    const rows = await reader(ACTIVATION);
    expect(rows.kind).toBe("rows");
    const newest = (rows as { newest: Map<Hex, number> }).newest;
    expect(newest.get(idFrom(1))).toBe(ACTIVATION + 401);
    expect(newest.has(idFrom(0xfe))).toBe(false);
    expect((pages[1] as { variables: { after: string } }).variables.after).toBe(idFrom(499 % 200));

    answers.push({ errors: [{ message: "field 'Lookalike' not found in type: 'query_root'", extensions: { code: "validation-failed" } }] });
    expect(await reader(ACTIVATION)).toEqual({ kind: "absent" });

    answers.push({ errors: [{ message: "database query error", extensions: { code: "unexpected" } }] });
    expect((await reader(ACTIVATION)).kind).toBe("failed");
    answers.push(new Response("bad gateway", { status: 502 }));
    expect((await reader(ACTIVATION)).kind).toBe("failed");
    answers.push({ data: { Lookalike: [{ id: "not-an-id", executedAt: "1" }] } });
    expect((await reader(ACTIVATION)).kind).toBe("failed");
  });
});
