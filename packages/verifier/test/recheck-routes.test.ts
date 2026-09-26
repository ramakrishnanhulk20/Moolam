// Covers the four re-check routes: the public request and status, and the three the runner holds a
// token for. It holds up what the queue promises from outside: an id that is not a passport, a
// passport the index does not know, a sealed passport whose picture was never published, one whose
// holder published it later (queued like a public one, including 11 seconds after a sealed answer),
// one whose record lookup failed (queued, the runner decides), the same request twice, ten a minute from one address, a queue with no room left, a host with no runner
// token at all, a wrong token, a claim another runner is already on, a claim abandoned for half an
// hour, a report with a transaction and one without, and the two counts /health carries.
// The sealed lookup and the unseal record finder are injected, so no test here reads a gateway or Pinata, and the queue store is injected
// where a test needs the service to start with work already in it.
// Does NOT cover the queue module's own rules, which are in test/recheck-queue.test.ts, and does
// not cover the runner, which lives in its own package and is another order.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { QueueStore, RecheckItem } from "../src/recheck/queue.js";
import { unsealRecord, type UnsealRecord } from "../src/unseal.js";
import type { Hex, PassportRecord } from "../src/types.js";

vi.hoisted(() => {
  process.env.X402_ENABLED = "false";
  process.env.GENERATOR_WALLET_ID = "";
  process.env.EXPECT_ROUTES = "";
  process.env.RUNNER_TOKEN = "";
});

const { buildServer } = await import("../src/server.js");

const TOKEN = "moolam-runner-token-for-tests-0001";
const PUBLIC = "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex;
const SEALED = "0x2222222222222222222222222222222222222222222222222222222222222222" as Hex;
const SECOND = "0x3333333333333333333333333333333333333333333333333333333333333333" as Hex;
const UNKNOWN = "0x4444444444444444444444444444444444444444444444444444444444444444" as Hex;
const UNSEALED = "0x5555555555555555555555555555555555555555555555555555555555555555" as Hex;
const LOOKUP_DOWN = "0x6666666666666666666666666666666666666666666666666666666666666666" as Hex;
const SEALED_LATER = "0x7777777777777777777777777777777777777777777777777777777777777777" as Hex;
const SEALED_BRIEFLY = "0x8888888888888888888888888888888888888888888888888888888888888888" as Hex;
const TX = "0xabababababababababababababababababababababababababababababababab";

const HALF_HOUR = 30 * 60 * 1000;

function record(id: Hex, metadataURI: string): PassportRecord {
  return {
    id,
    phash: 1234567890123456789n,
    blockhash: "0x00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff" as Hex,
    creator: "0x1111111111111111111111111111111111111111" as Hex,
    parentId: null,
    registeredAt: 1_757_000_000,
    metadataURI,
  };
}

const source = {
  load: async (): Promise<PassportRecord[]> => [
    record(PUBLIC, "ipfs://public"),
    record(SEALED, "ipfs://sealed"),
    record(SECOND, "ipfs://public"),
    record(UNSEALED, "ipfs://sealed"),
    record(LOOKUP_DOWN, "ipfs://sealed"),
    record(SEALED_LATER, "ipfs://sealed"),
    record(SEALED_BRIEFLY, "ipfs://sealed"),
  ],
};

/** Counts the document reads, so the test can prove the sealed answer is only fetched once. */
const reads: string[] = [];
const readDocument = async (uri: string): Promise<unknown> => {
  reads.push(uri);
  return uri === "ipfs://sealed" ? { sealed: true } : { name: "a picture", image: "ipfs://bafypicture" };
};

/** The passports whose holders have published the picture, as the record finder sees them. */
const published = new Set<Hex>([UNSEALED]);
const findRecord = async (passportId: Hex): Promise<UnsealRecord | undefined> => {
  if (passportId === LOOKUP_DOWN) {
    throw new Error("Pinata answered 500 to the record lookup");
  }
  if (!published.has(passportId)) {
    return undefined;
  }
  return unsealRecord({
    passportId,
    image: "ipfs://bafyimage",
    thumbnail: "ipfs://bafythumb",
    unsealedBy: "0x85a88ca81ff5f681d96ab86fa60ccb8452a139a6" as Hex,
    unsealedAt: new Date("2026-09-22T12:27:28Z"),
  });
};

function waiting(count: number, from: number): RecheckItem[] {
  return Array.from({ length: count }, (_, index) => ({
    passportId: `0x${(index + 1).toString(16).padStart(64, "0")}` as Hex,
    status: "pending" as const,
    requestedAt: from + index,
    requestedBy: "public" as const,
  }));
}

function storeOf(items: RecheckItem[]): QueueStore {
  return { read: () => ({ items }), write: () => {} };
}

let app: FastifyInstance;
/** A host that has not set RUNNER_TOKEN, so it has no runner at all. */
let noRunner: FastifyInstance;
/** A host whose queue is already full of requests nobody has run. */
let full: FastifyInstance;
/** A host with a page of waiting requests, one run in progress and one a runner walked away from. */
let busy: FastifyInstance;

const STALE = "0x00000000000000000000000000000000000000000000000000000000000000aa" as Hex;
const FRESH = "0x00000000000000000000000000000000000000000000000000000000000000bb" as Hex;

beforeAll(async () => {
  const now = Date.now();
  app = await buildServer({ source, logger: false, recheck: { runnerToken: TOKEN, readDocument, findRecord } });
  noRunner = await buildServer({ source, logger: false, recheck: { runnerToken: "", readDocument, findRecord } });
  full = await buildServer({
    source,
    logger: false,
    recheck: { runnerToken: TOKEN, readDocument, store: storeOf(waiting(1000, now)) },
  });
  busy = await buildServer({
    source,
    logger: false,
    recheck: {
      runnerToken: TOKEN,
      readDocument,
      findRecord,
      store: storeOf([
        ...waiting(60, now),
        { passportId: STALE, status: "running", requestedAt: now - 40 * 60 * 1000, requestedBy: "public", startedAt: now - HALF_HOUR - 60_000 },
        { passportId: FRESH, status: "running", requestedAt: now - 60_000, requestedBy: "public", startedAt: now - 30_000 },
      ]),
    },
  });
  await Promise.all([app.ready(), noRunner.ready(), full.ready(), busy.ready()]);
});

afterAll(async () => {
  await Promise.all([app.close(), noRunner.close(), full.close(), busy.close()]);
});

async function ask(passportId: string, ip: string): Promise<LightMyRequestResponse> {
  return await app.inject({
    method: "POST",
    url: "/recheck/request",
    payload: { passportId },
    remoteAddress: ip,
  });
}

const runner = { authorization: `Bearer ${TOKEN}` };

describe("POST /recheck/request", () => {
  it("refuses a body that is not a passport id", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/recheck/request",
      payload: { passportId: "0x123" },
      remoteAddress: "198.51.100.1",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("64 hex characters");
  });

  it("answers 404 for a passport this service's index does not know", async () => {
    const response = await ask(UNKNOWN, "198.51.100.2");

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "no-passport", passportId: UNKNOWN });
  });

  it("refuses a sealed passport, because there is no picture to re-check", async () => {
    const response = await ask(SEALED, "198.51.100.3");
    const after = await app.inject({ method: "GET", url: `/recheck/status/${SEALED}` });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "sealed", passportId: SEALED });
    expect(after.json().status).toBe("none");
  });

  it("records a request as pending, and says where it is in the queue", async () => {
    const response = await ask(PUBLIC, "198.51.100.4");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ passportId: PUBLIC, status: "pending", position: 1, already: false });
    expect(typeof response.json().requestedAt).toBe("number");
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("answers the same request twice with the same record, and reads the document once", async () => {
    const before = reads.filter((uri) => uri === "ipfs://public").length;
    const first = await ask(SECOND, "198.51.100.5");
    const again = await ask(SECOND, "198.51.100.6");
    const after = reads.filter((uri) => uri === "ipfs://public").length;

    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ already: true, status: "pending" });
    expect(again.json().requestedAt).toBe(first.json().requestedAt);
    expect(after - before).toBe(1);
  });

  it("allows ten a minute from one address and refuses the eleventh", async () => {
    const codes: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await ask(PUBLIC, "198.51.100.77");
      codes.push(response.statusCode);
    }

    expect(codes.slice(0, 10).every((code) => code === 200)).toBe(true);
    expect(codes[10]).toBe(429);
  });

  it("refuses a new request when the queue is full of work nobody has run", async () => {
    const response = await full.inject({
      method: "POST",
      url: "/recheck/request",
      payload: { passportId: PUBLIC },
      remoteAddress: "198.51.100.8",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe("queue-full");
  });

  it("queues a passport its holder unsealed like a public one, though its document still says sealed", async () => {
    const response = await ask(UNSEALED, "198.51.100.11");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ passportId: UNSEALED, status: "pending", already: false });
  });

  it("queues a sealed passport whose record lookup failed, and leaves the runner to decide", async () => {
    const response = await ask(LOOKUP_DOWN, "198.51.100.12");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ passportId: LOOKUP_DOWN, status: "pending" });
  });

  // The rule the verify answer's picture fact follows since fa2efd0: "sealed" is at most 10 s old.
  it("queues a passport its holder unsealed 11 seconds after a read that said sealed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      expect((await ask(SEALED_BRIEFLY, "198.51.100.14")).statusCode).toBe(409);
      published.add(SEALED_BRIEFLY);

      vi.setSystemTime(Date.now() + 11_000);
      const later = await ask(SEALED_BRIEFLY, "198.51.100.14");
      expect(later.statusCode).toBe(200);
      expect(later.json()).toMatchObject({ passportId: SEALED_BRIEFLY, status: "pending", already: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds a sealed answer for a while, then queues the passport once its holder has unsealed it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      expect((await ask(SEALED_LATER, "198.51.100.13")).statusCode).toBe(409);
      published.add(SEALED_LATER);
      expect((await ask(SEALED_LATER, "198.51.100.13")).statusCode).toBe(409);

      vi.setSystemTime(Date.now() + 61_000);
      const later = await ask(SEALED_LATER, "198.51.100.13");
      expect(later.statusCode).toBe(200);
      expect(later.json()).toMatchObject({ passportId: SEALED_LATER, status: "pending" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("GET /recheck/status/:passportId", () => {
  it("refuses an id that is not a passport id", async () => {
    const response = await app.inject({ method: "GET", url: "/recheck/status/0xnope" });

    expect(response.statusCode).toBe(400);
  });

  it("says nobody has asked, and lets the answer be held for thirty seconds", async () => {
    const response = await app.inject({ method: "GET", url: `/recheck/status/${UNKNOWN}` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ passportId: UNKNOWN, status: "none" });
    expect(response.headers["cache-control"]).toBe("public, max-age=30");
  });
});

describe("the runner's token", () => {
  const routes = [
    { method: "GET" as const, url: "/recheck/queue" },
    { method: "POST" as const, url: "/recheck/claim", payload: { passportId: PUBLIC } },
    { method: "POST" as const, url: "/recheck/done", payload: { passportId: PUBLIC, reportTx: TX } },
  ];

  it("answers 503 on a host that has not set one", async () => {
    for (const route of routes) {
      const response = await noRunner.inject(route);
      expect(response.statusCode).toBe(503);
      expect(response.json().error).toBe("runner-disabled");
    }
  });

  it("answers 401 for a missing token and for the wrong one", async () => {
    for (const route of routes) {
      const missing = await app.inject(route);
      const wrong = await app.inject({
        ...route,
        headers: { authorization: "Bearer moolam-runner-token-for-tests-9999" },
      });
      expect(missing.statusCode).toBe(401);
      expect(wrong.statusCode).toBe(401);
    }
  });
});

describe("GET /recheck/queue", () => {
  it("hands the runner the oldest waiting requests, at most fifty, and marks nothing", async () => {
    const response = await busy.inject({ method: "GET", url: "/recheck/queue", headers: runner });
    const again = await busy.inject({ method: "GET", url: "/recheck/queue", headers: runner });

    expect(response.statusCode).toBe(200);
    expect(response.json().items).toHaveLength(50);
    // The claim a runner walked away from half an hour ago counts as waiting again (pass 4, V19).
    expect(response.json()).toMatchObject({ pending: 61, running: 1 });
    expect(response.json().items[0]).toMatchObject({ requestedBy: "public" });
    expect(again.json().items[0].passportId).toBe(response.json().items[0].passportId);
    expect(response.headers["cache-control"]).toBe("no-store");
  });
});

describe("POST /recheck/claim", () => {
  it("refuses a passport nobody has asked about", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/recheck/claim",
      payload: { passportId: UNKNOWN },
      headers: runner,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe("no-request");
  });

  it("takes a waiting request and refuses a second runner on the same one", async () => {
    await ask(PUBLIC, "198.51.100.9");
    const claimed = await app.inject({
      method: "POST",
      url: "/recheck/claim",
      payload: { passportId: PUBLIC },
      headers: runner,
    });
    const second = await app.inject({
      method: "POST",
      url: "/recheck/claim",
      payload: { passportId: PUBLIC },
      headers: runner,
    });

    expect(claimed.statusCode).toBe(200);
    expect(claimed.json()).toMatchObject({ passportId: PUBLIC, status: "running", reclaimed: false });
    expect(typeof claimed.json().startedAt).toBe("number");
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("already-running");
    expect(claimed.headers["cache-control"]).toBe("no-store");
  });

  it("lets a request be taken again when the runner that claimed it has been gone half an hour", async () => {
    const stale = await busy.inject({
      method: "POST",
      url: "/recheck/claim",
      payload: { passportId: STALE },
      headers: runner,
    });
    const fresh = await busy.inject({
      method: "POST",
      url: "/recheck/claim",
      payload: { passportId: FRESH },
      headers: runner,
    });

    expect(stale.statusCode).toBe(200);
    expect(stale.json()).toMatchObject({ status: "running", reclaimed: true });
    expect(fresh.statusCode).toBe(409);
  });
});

describe("POST /recheck/done", () => {
  it("refuses a report for a passport nobody asked about, and for one nobody claimed", async () => {
    const unknown = await app.inject({
      method: "POST",
      url: "/recheck/done",
      payload: { passportId: UNKNOWN, reportTx: TX },
      headers: runner,
    });
    await ask(SECOND, "198.51.100.10");
    const unclaimed = await app.inject({
      method: "POST",
      url: "/recheck/done",
      payload: { passportId: SECOND, reportTx: TX },
      headers: runner,
    });

    expect(unknown.statusCode).toBe(404);
    expect(unclaimed.statusCode).toBe(409);
    expect(unclaimed.json().error).toBe("not-running");
  });

  it("refuses a report transaction that is not a transaction hash", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/recheck/done",
      payload: { passportId: PUBLIC, reportTx: "0x00" },
      headers: runner,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("reportTx");
  });

  it("closes a claimed request with the transaction the report landed in", async () => {
    const done = await busy.inject({
      method: "POST",
      url: "/recheck/done",
      payload: { passportId: FRESH, reportTx: TX, matched: true, distance: 3 },
      headers: runner,
    });
    const status = await busy.inject({ method: "GET", url: `/recheck/status/${FRESH}` });

    expect(done.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      passportId: FRESH,
      status: "done",
      reportTx: TX,
      matched: true,
      distance: 3,
    });
    expect(typeof status.json().finishedAt).toBe("number");
  });

  it("closes a run with no transaction as failed, with the reason cut to 200 characters", async () => {
    const failed = await busy.inject({
      method: "POST",
      url: "/recheck/done",
      payload: { passportId: STALE, reason: "the simulator timed out. ".repeat(40) },
      headers: runner,
    });

    expect(failed.statusCode).toBe(200);
    expect(failed.json().status).toBe("failed");
    expect(failed.json().reason).toHaveLength(200);
    expect(failed.json().reportTx).toBeUndefined();
  });
});

describe("GET /health", () => {
  it("says how many second opinions are waiting and how many are being run", async () => {
    const now = Date.now();
    const counted = await buildServer({
      source,
      logger: false,
      recheck: {
        runnerToken: TOKEN,
        readDocument,
        findRecord,
        store: storeOf([
          ...waiting(2, now),
          { passportId: FRESH, status: "running", requestedAt: now, requestedBy: "public", startedAt: now },
        ]),
      },
    });
    await counted.ready();

    const response = await counted.inject({ method: "GET", url: "/health" });
    await counted.close();

    expect(response.json().recheck).toEqual({ pending: 2, running: 1 });
  });
});
