// Covers the two routes Chainlink's nodes read during a look-alike run (WO-275a). The candidates
// route answers only passports registered strictly before asOf within the shared thresholds,
// oldest first by the shared rule, at most three, the earliest always among them, one place per
// fingerprint however many copies carry it (L10, L11, L16). Two asks with the same asOf get the
// same bytes; an index not loaded through asOf answers not-ready; anything malformed is refused
// 400 before a scan (L16). A candidates question newer than the copy in hand first waits for one
// catch-up load (WO-331): questions at the same time share it, a second starts no sooner than five
// seconds after the first, and one slower than six seconds is answered not-ready. The backlog lists the passports still waiting for a network verdict or,
// for an original, a look-alike record, that the workflow can check, oldest first, and says
// not-ready rather than a partial list; with either setting unset it is off, says not-ready and
// shows under `off` on /health with the boot log naming it (L14's list side). Its start moves by
// the cron slot, so passports the workflow can never finish do not hold the head of every answer,
// and a passport whose newest network verdict says "no match" is left out. Neither
// route reads the chain or a gateway while a request waits, and both sit under the service's 60 a
// minute per address and a ceiling of their own (L18). The look-alike records come from
// LookalikeChecked events read by the background refresh, counted only at or after activation,
// and the network verdict from the index's own Attestation.network flag. Once the index serves its own
// Lookalike rows (WO-276) they replace the chain scan, which stands in only while the index has no
// such entity and is asked again after ten minutes; an index that served them and then fails a read
// leaves the backlog not-ready.
// Does NOT cover the live index, a real RPC or the gateway: the index is a stub source or a local
// mock GraphQL server, the chain a stub, the documents a stub reader, and the six second catch-up
// wait runs on vitest's fake timers. The prepare warning is
// test/lookalike-presign.test.ts, the rule file itself test/lookalike-rule.test.ts.

import fs from "node:fs";
import { createServer, type Server } from "node:http";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HammingIndex } from "../src/index.js";
import type { BacklogSettings } from "../src/lookalike/backlog.js";
import { INDEX_ABSENT_RETRY_MS, lookalikeKnowledge } from "../src/lookalike/knowledge.js";
import { envioLookalikeReader, type IndexedLookalikes, type LookalikeIndexReader } from "../src/lookalike/indexRecords.js";
import { LEDGER_CHUNK_BLOCKS, type LedgerChain, type LedgerLog } from "../src/lookalike/ledger.js";
import { UnreachableTarget } from "../src/net/safeFetch.js";
import { buildServer } from "../src/server.js";
import { EnvioSource, NETWORK_FLAG_RETRY_MS } from "../src/source/EnvioSource.js";
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
    // The index's flag always says what the newest network verdict found, so a verdict here does too.
    ...(extra.networkVerdict === true ? { networkMatched: true } : {}),
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
    /** Replaces the source built from `records` and `through`. */
    source?: PassportSource;
    indexClock?: () => number;
  } = {},
): Promise<FastifyInstance> {
  app = await buildServer({
    source: options.source ?? indexedThrough(records, options.through),
    logger: false,
    index: { refreshMs: 0, clock: options.indexClock ?? (() => NOW * 1000) },
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

/**
 * A source whose indexer has read through `state.through` as each load begins, counting every load,
 * the boot's included. While `state.held` is set, a load waits on it before it answers.
 */
function catchingUp(records: PassportRecord[], through: number) {
  const state: { through: number; loads: number; held?: Promise<void> } = { through, loads: 0 };
  const source: PassportSource = {
    load: async () => records,
    loadWithProgress: async () => {
      state.loads += 1;
      const read = state.through;
      if (state.held !== undefined) await state.held;
      return { records, progress: { block: 100_000, blockTime: read, headTime: read, syncing: false } };
    },
  };
  return { source, state };
}

function gate(): { wait: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

describe("POST /lookalikes/candidates: a passport newer than the copy in hand (WO-331)", () => {
  const LOADED_TO = 1_000;
  const FRESH = { fingerprints: ONE_PAIR, asOf: 1_001 };
  const FOUND = { status: "ok", candidates: [idFrom(1)] };

  it("loads the index once on the spot and answers ok when that load covers asOf", async () => {
    const { source, state } = catchingUp([passport(1, 100)], LOADED_TO);
    const server = await serve([], { source });
    state.through = FRESH.asOf;

    expect((await ask(server, FRESH)).json).toEqual(FOUND);
    expect(state.loads).toBe(2);
  });

  it("shares one load between two questions that arrive while it runs", async () => {
    const { source, state } = catchingUp([passport(1, 100)], LOADED_TO);
    const server = await serve([], { source });
    const hold = gate();
    state.through = FRESH.asOf;
    state.held = hold.wait;
    const caughtUp = vi.spyOn(server.verifier, "catchUp");

    const answers = Promise.all([ask(server, FRESH, "198.51.100.1"), ask(server, FRESH, "203.0.113.9")]);
    await vi.waitFor(() => expect(caughtUp).toHaveBeenCalledTimes(2));
    hold.open();

    expect((await answers).map((answer) => answer.json)).toEqual([FOUND, FOUND]);
    expect(state.loads).toBe(2);
  });

  it("answers not-ready when the load it waited for still does not cover asOf", async () => {
    const { source, state } = catchingUp([passport(1, 100)], LOADED_TO);
    const server = await serve([], { source });

    expect((await ask(server, FRESH)).json).toEqual({ status: "not-ready" });
    expect(state.loads).toBe(2);
  });

  it("starts no second load inside the five second gap, and one once the gap has passed", async () => {
    let now = NOW * 1000;
    const { source, state } = catchingUp([passport(1, 100)], LOADED_TO);
    const server = await serve([], { source, indexClock: () => now });

    expect((await ask(server, FRESH)).json).toEqual({ status: "not-ready" });
    state.through = FRESH.asOf;
    now += 4_999;
    expect((await ask(server, FRESH)).json).toEqual({ status: "not-ready" });
    expect(state.loads).toBe(2);

    now += 1;
    expect((await ask(server, FRESH)).json).toEqual(FOUND);
    expect(state.loads).toBe(3);
  });

  it("answers not-ready at six seconds when the load is slower, and starts no other load", async () => {
    const { source, state } = catchingUp([passport(1, 100)], LOADED_TO);
    const server = await serve([], { source });
    const hold = gate();
    state.through = FRESH.asOf;
    state.held = hold.wait;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let answered = false;
      const answering = ask(server, FRESH).then((answer) => {
        answered = true;
        return answer;
      });
      // The wait's timer is the only one this request sets, so the clock moves only once it is set.
      for (let turn = 0; turn < 1_000 && vi.getTimerCount() === 0; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(5_999);
      expect(answered).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect((await answering).json).toEqual({ status: "not-ready" });
    } finally {
      vi.useRealTimers();
      hold.open();
    }
    expect(state.loads).toBe(2);
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

/**
 * Everything the service logs while `work` runs, by both roads pino takes to the terminal: a plain
 * node run writes through process.stdout, and under this runner pino writes to descriptor 1 through
 * fs.write. The same capture claims-routes.test.ts uses.
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
    const late = await serve(waitingRoom(), { through: 400, settings: BOTH, readDocument: docs.read, chain: ledgerChain(RECORDS).chain });
    await late.lookalikes.refresh(late.verifier.snapshot().passports);
    expect((await backlog(late, "asOf=401&n=7")).json).toEqual({ status: "not-ready" });
    expect((await backlog(late, "asOf=400&n=7")).json).toEqual({
      status: "ok",
      passports: [idFrom(1), idFrom(0x0b), idFrom(0x0e), idFrom(9)],
    });
    await late.close();

    // A passport the index says nothing about is "cannot tell", never "no verdict".
    const unknown = await serve([passport(1, 100)], { settings: BOTH, readDocument: docs.read, chain: ledgerChain([]).chain });
    await unknown.lookalikes.refresh(unknown.verifier.snapshot().passports);
    expect((await backlog(unknown, "asOf=500&n=7")).json).toEqual({ status: "not-ready" });
    await unknown.close();

    // A verdict whose index row does not say what it found is "cannot tell" too.
    const unsaid = await serve([passport(1, 100, { networkVerdict: true, networkMatched: undefined })], {
      settings: BOTH,
      readDocument: docs.read,
      chain: ledgerChain([]).chain,
    });
    await unsaid.lookalikes.refresh(unsaid.verifier.snapshot().passports);
    expect((await backlog(unsaid, "asOf=500&n=7")).json).toEqual({ status: "not-ready" });
  });

  it("leaves out a passport whose document read failed and reads it again on a later refresh", async () => {
    const docs = documents({ ...SPECIAL, "ipfs://bafkdoc1": new UnreachableTarget("gateway answered 504") });
    const server = await serve(waitingRoom(), { settings: BOTH, readDocument: docs.read, chain: ledgerChain(RECORDS).chain });
    await server.lookalikes.refresh(server.verifier.snapshot().passports);

    expect((await backlog(server, "asOf=500&n=7")).json).toEqual({
      status: "ok",
      passports: [idFrom(0x0b), idFrom(0x0e), idFrom(9)],
    });
    expect(docs.reads.filter((uri) => uri === "ipfs://bafkdoc1")).toHaveLength(1);
  });

  it("refuses a malformed query with 400", async () => {
    const server = await serve(waitingRoom(), { settings: BOTH });
    const queries = [
      "asOf=500",
      "n=3",
      "asOf=500&n=0",
      "asOf=500&n=8",
      "asOf=abc&n=1",
      "asOf=500&n=1&x=1",
      "asOf=500&asOf=501&n=1",
      `asOf=${NOW + 61}&n=1`,
      "asOf=500&n=1&slot=-1",
      "asOf=500&n=1&slot=abc",
      "asOf=500&n=1&slot=12345678901",
      "asOf=500&n=1&slot=1&slot=2",
      "asOf=500&n=1&slot=",
    ];
    for (const query of queries) {
      expect((await backlog(server, query)).status, query).toBe(400);
    }
  });
});

describe("GET /lookalikes/backlog when a setting is unset", () => {
  const settingsLeft: [string, BacklogSettings, string][] = [
    ["neither", {}, "NETWORK_ACTIVATION_TIME or LOOKALIKE_RECEIVER"],
    ["the activation time only", { activation: ACTIVATION }, "LOOKALIKE_RECEIVER"],
    ["the receiver only", { receiver: RECEIVER }, "NETWORK_ACTIVATION_TIME"],
  ];

  it.each(settingsLeft)("answers not-ready with %s set, reads nothing, and /health lists it under off with the reason", async (_name, settings, missing) => {
    const docs = documents();
    const { chain, calls } = ledgerChain([]);
    const server = await serve([passport(1, 100, { networkVerdict: false })], { settings, readDocument: docs.read, chain });
    await server.lookalikes.refresh(server.verifier.snapshot().passports);

    // The same shape the candidates route answers when it cannot judge yet.
    expect((await backlog(server, "asOf=500&n=7")).json).toEqual({ status: "not-ready" });
    expect(docs.reads).toEqual([]);
    expect(calls.logs).toEqual([]);

    const health = (await server.inject({ method: "GET", url: "/health" })).json() as {
      routes: string[];
      off: { route: string; reason: string }[];
    };
    expect(health.routes).not.toContain("lookalikes/backlog");
    expect(health.routes).toContain("lookalikes/candidates");
    expect(health.off).toContainEqual({ route: "GET /lookalikes/backlog", reason: expect.stringContaining(`has no ${missing}`) });
    expect(JSON.stringify(health.off)).not.toContain(RECEIVER);
  });

  it("is on, and not under off, once both are set", async () => {
    const server = await serve([passport(1, 100, { networkVerdict: false })], {
      settings: { activation: ACTIVATION, receiver: RECEIVER },
      readDocument: documents().read,
      chain: ledgerChain([]).chain,
    });
    await server.lookalikes.refresh(server.verifier.snapshot().passports);

    expect((await backlog(server, "asOf=500&n=7")).json).toEqual({ status: "ok", passports: [idFrom(1)] });
    const health = (await server.inject({ method: "GET", url: "/health" })).json() as {
      routes: string[];
      off: { route: string }[];
    };
    expect(health.routes).toContain("lookalikes/backlog");
    expect(health.off.map((off) => off.route)).not.toContain("GET /lookalikes/backlog");
  });

  it("says so in the boot log, naming the settings and no value", async () => {
    const { logged } = await captureLog(async () => {
      const server = await buildServer({
        source: indexedThrough([]),
        logger: true,
        index: { refreshMs: 0, clock: () => NOW * 1000 },
        lookalikes: { settings: { receiver: RECEIVER }, clock: () => NOW * 1000 },
      });
      await server.ready();
      app = server;
      return server;
    });

    expect(logged).toContain("look-alike backlog off: it needs NETWORK_ACTIVATION_TIME and LOOKALIKE_RECEIVER");
    expect(logged).toContain("has no NETWORK_ACTIVATION_TIME");
    expect(logged).not.toContain(RECEIVER);
  });
});

describe("GET /lookalikes/backlog: the start rotates by the cron slot", () => {
  // Two passports whose newest network verdict says "no match" and four whose picture the
  // workflow cannot measure (a PNG, too many bytes) sit at the head of the oldest-first order,
  // ahead of six passports it can finish. The service sees the first two in the index's flag and
  // leaves them out; it cannot see the other four, so they stay in the list and the rotation is
  // what gets the six past them.
  const BOTH_SET: BacklogSettings = { activation: ACTIVATION, receiver: RECEIVER };
  const wrongPrints = [1, 2];
  const unmeasurable = [3, 4, 5, 6];
  const finishable = [7, 8, 9, 10, 11, 12];
  const waiting = [...unmeasurable, ...finishable];
  const index = (): PassportRecord[] => [
    ...wrongPrints.map((byte) => passport(byte, 100 + byte, { networkVerdict: true, networkMatched: false })),
    ...waiting.map((byte) => passport(byte, 100 + byte, { networkVerdict: false })),
  ];

  async function node(records = index()): Promise<FastifyInstance> {
    const server = await serve(records, { settings: BOTH_SET, readDocument: documents().read, chain: ledgerChain([]).chain });
    await server.lookalikes.refresh(server.verifier.snapshot().passports);
    return server;
  }

  async function slots(server: FastifyInstance, n: number, count: number, from = 0): Promise<Hex[][]> {
    const lists: Hex[][] = [];
    for (let slot = from; slot < from + count; slot += 1) {
      const answer = (await backlog(server, `asOf=500&n=${n}&slot=${slot}`, `198.51.100.${slot % 200}`)).json;
      expect(answer.status).toBe("ok");
      lists.push(answer.passports as Hex[]);
    }
    return lists;
  }

  it("leaves out a passport whose newest network verdict says no match, and starts the others at the head with no slot", async () => {
    const server = await node();
    const named = (await backlog(server, "asOf=500&n=7")).json.passports as Hex[];
    expect(named).toEqual(waiting.slice(0, 7).map(idFrom));
    expect(named).not.toContain(idFrom(1));
    expect(named).not.toContain(idFrom(2));
  });

  it("offers every waiting passport, the six it can finish included, within as many slots as the list is long", async () => {
    const server = await node();
    const lists = await slots(server, 3, waiting.length);

    // With no rotation the answer is always slot 0's, three passports it can never finish.
    expect(lists[0]).toEqual([3, 4, 5].map(idFrom));
    const offered = new Set(lists.flat());
    for (const byte of finishable) expect(offered.has(idFrom(byte)), `passport ${byte}`).toBe(true);
    // Each one leads an answer exactly once in a lap, so a run that works its first entry first reaches it.
    expect(lists.map((list) => list[0])).toEqual(waiting.map(idFrom));
    expect(lists[4]).toEqual([7, 8, 9].map(idFrom));
    expect(lists[8]).toEqual([11, 12, 3].map(idFrom));
    // The lap repeats.
    expect((await slots(server, 3, 3, waiting.length)).map((list) => list[0])).toEqual([3, 4, 5].map(idFrom));
  });

  it("gives the same list for the same slot on every node, and the next place for the next slot", async () => {
    const first = await node();
    const second = await node(index());
    const asked = await slots(first, 4, 3, 100);
    expect(await slots(second, 4, 3, 100)).toEqual(asked);
    expect(await slots(first, 4, 3, 100)).toEqual(asked);
    expect(asked[1]?.[0]).toBe(asked[0]?.[1]);
    // A slot far out is the same as its place in the lap.
    const huge = (await backlog(first, "asOf=500&n=2&slot=9999999999")).json.passports as Hex[];
    const place = 9_999_999_999 % waiting.length;
    expect(huge).toEqual([waiting[place], waiting[(place + 1) % waiting.length]].map((byte) => idFrom(byte as number)));
  });

  it("moves the start of a list shorter than the answer too, so a leading passport is never first for good", async () => {
    const server = await node([passport(3, 103, { networkVerdict: false }), passport(4, 104, { networkVerdict: false })]);
    const lists = await slots(server, 7, 3);
    expect(lists.map((list) => list.length)).toEqual([2, 2, 2]);
    expect(lists.map((list) => list[0])).toEqual([3, 4, 3].map(idFrom));
  });
});

describe("GET /lookalikes/backlog: a verdict that found no match", () => {
  it("never waits for a look-alike record the workflow does not write for it, but still waits for a missing verdict", async () => {
    const server = await serve(
      [
        passport(1, 100, { networkVerdict: true, networkMatched: false }),
        passport(2, 101, { networkVerdict: true, networkMatched: true }),
        passport(3, 102, { networkVerdict: false }),
      ],
      { settings: { activation: ACTIVATION, receiver: RECEIVER }, readDocument: documents().read, chain: ledgerChain([]).chain },
    );
    await server.lookalikes.refresh(server.verifier.snapshot().passports);
    expect((await backlog(server, "asOf=500&n=7")).json).toEqual({ status: "ok", passports: [idFrom(2), idFrom(3)] });
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
  it("reads whether the network wrote a verdict, and what it found, from the index's own Attestation.network flag", async () => {
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
        const body = {
          data: {
            Passport: [row(1, [{ matched: true }]), row(2, [{ matched: false }]), row(3, []), row(4), row(5, "junk"), row(6, [{ at: "1" }])],
          },
        };
        reply.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    running = server;
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/graphql`;

    const records = await new EnvioSource({ url, network: true }).load();
    expect(records.map((record) => [record.networkVerdict, record.networkMatched])).toEqual([
      [true, true],
      [true, false],
      [false, undefined],
      [undefined, undefined],
      [undefined, undefined],
      [undefined, undefined],
    ]);
    expect(asked[0]).toContain("network: attestations(where: { network: { _eq: true } }, order_by: { at: desc }, limit: 1)");
    // No receiver or time of the service's own goes into the query: the flag is the one rule.
    expect(asked[0]).not.toContain(RECEIVER);
    expect(asked[0]).not.toContain(String(ACTIVATION));

    await new EnvioSource({ url }).load();
    expect(asked[1]).not.toContain("network:");
  });

  it("loads an index that does not serve the flag without it, so every passport reads cannot-tell, and asks again after ten minutes", async () => {
    const asked: string[] = [];
    let serves = false;
    const server = createServer((request, reply) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const query = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { query: string }).query;
        asked.push(query);
        const missingField = query.includes("network:") && !serves;
        const body = missingField
          ? {
              errors: [
                { message: "field 'network' not found in type: 'Attestation_bool_exp'", extensions: { code: "validation-failed" } },
              ],
            }
          : {
              data: {
                Passport: [
                  {
                    id: idFrom(1),
                    phash: "0",
                    blockhash: ZERO_BLOCKHASH,
                    creator: { id: OTHER },
                    registeredAt: "100",
                    metadataURI: "ipfs://bafkdoc",
                    ...(query.includes("network:") ? { network: [{ matched: true }] } : {}),
                  },
                ],
              },
            };
        reply.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    running = server;
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/graphql`;
    let now = NOW * 1000;
    const source = new EnvioSource({ url, network: true, clock: () => now });

    const without = await source.load();
    expect(without.map((record) => record.networkVerdict)).toEqual([undefined]);
    expect(asked.filter((query) => query.includes("network:"))).toHaveLength(1);

    await source.load();
    expect(asked.filter((query) => query.includes("network:"))).toHaveLength(1);

    serves = true;
    now += NETWORK_FLAG_RETRY_MS;
    expect((await source.load()).map((record) => record.networkVerdict)).toEqual([true]);
  });

  it("still fails the load on any other GraphQL error", async () => {
    const server = createServer((request, reply) => {
      request.resume();
      request.on("end", () => {
        reply.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ errors: [{ message: "the database is down" }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    running = server;
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/graphql`;
    await expect(new EnvioSource({ url, network: true }).load()).rejects.toThrow(/the database is down/);
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
