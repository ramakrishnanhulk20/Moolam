import { afterEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import {
  VerifierError,
  readRecheckStatus,
  recheckRequestSchema,
  recheckStatusSchema,
  requestRecheck,
} from "@/lib/verifier/client";

/**
 * The two calls behind the re-check button, against the routes in
 * packages/verifier/src/routes/recheck.ts.
 *
 * The status read is the one with teeth. It never throws, and it tells three
 * answers apart that a lazier reader would collapse into one: a service that
 * knows of no request, a service that has no queue route at all, and a service
 * that could not say. The first two leave a reader free to ask; the third must
 * never be drawn as either.
 */

const PASSPORT = `0x${"7c".repeat(32)}` as Hex;
const OTHER = `0x${"3a".repeat(32)}` as Hex;
const TX = `0x${"91".repeat(32)}` as Hex;

function stubFetch(status: number, body: unknown, ok = status < 400) {
  const fetchStub = vi.fn(async () => ({ ok, status, json: async () => body }));
  vi.stubGlobal("fetch", fetchStub);
  return fetchStub;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the request that joins the queue", () => {
  it("posts the passport id as JSON and needs no token", async () => {
    const fetchStub = stubFetch(200, {
      passportId: PASSPORT,
      status: "pending",
      requestedAt: 1_790_000_000_000,
      position: 3,
      already: false,
    });

    const answer = await requestRecheck(PASSPORT);
    expect(answer.status).toBe("pending");
    expect(answer.position).toBe(3);
    expect(answer.already).toBe(false);

    const [url, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:4010/recheck/request");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ passportId: PASSPORT });
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers.authorization).toBeUndefined();
  });

  it("reads the answer for a passport somebody has already asked about", async () => {
    stubFetch(200, {
      passportId: PASSPORT,
      status: "running",
      requestedAt: 1_790_000_000_000,
      position: 0,
      already: true,
    });

    const answer = await requestRecheck(PASSPORT);
    expect(answer.already).toBe(true);
    expect(answer.status).toBe("running");
    expect(answer.position).toBe(0);
  });

  it("takes an answer that carries neither the position nor the already flag", () => {
    const parsed = recheckRequestSchema.safeParse({
      passportId: PASSPORT,
      status: "pending",
      requestedAt: 1_790_000_000_000,
    });
    expect(parsed.success).toBe(true);
  });

  it("refuses an answer with no status word in it", () => {
    expect(
      recheckRequestSchema.safeParse({ passportId: PASSPORT, requestedAt: 1_790_000_000_000 }).success,
    ).toBe(false);
  });

  it("keeps the route's own refusal word, so each one can have its own sentence", async () => {
    const refused: [number, string][] = [
      [404, "no-passport"],
      [409, "sealed"],
      [503, "queue-full"],
    ];

    for (const [status, word] of refused) {
      stubFetch(status, { error: word, passportId: PASSPORT }, false);
      const error = await requestRecheck(PASSPORT).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(VerifierError);
      expect((error as VerifierError).serviceCode, word).toBe(word);
      expect((error as VerifierError).status, word).toBe(status);
    }
  });

  it("calls a service that will not answer offline rather than passing the fetch error on", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("failed to fetch");
      }),
    );

    const error = await requestRecheck(PASSPORT).catch((thrown: unknown) => thrown);
    expect((error as VerifierError).code).toBe("offline");
  });

  it("names a rate limit as one, so the button can say wait a minute", async () => {
    stubFetch(429, { error: "too many requests" }, false);
    const error = await requestRecheck(PASSPORT).catch((thrown: unknown) => thrown);
    expect((error as VerifierError).code).toBe("rate-limited");
  });
});

describe("the read that says where a request stands", () => {
  it("parses every word the queue can answer with", async () => {
    const answers: [string, Record<string, unknown>][] = [
      ["pending", { passportId: PASSPORT, status: "pending", requestedAt: 1_790_000_000_000 }],
      [
        "running",
        { passportId: PASSPORT, status: "running", requestedAt: 1_790_000_000_000, startedAt: 1_790_000_060_000 },
      ],
      [
        "done",
        {
          passportId: PASSPORT,
          status: "done",
          requestedAt: 1_790_000_000_000,
          startedAt: 1_790_000_060_000,
          finishedAt: 1_790_000_300_000,
          reportTx: TX,
          matched: true,
          distance: 0,
        },
      ],
      [
        "failed",
        {
          passportId: PASSPORT,
          status: "failed",
          requestedAt: 1_790_000_000_000,
          finishedAt: 1_790_000_300_000,
          reason: "the picture could not be fetched from IPFS",
        },
      ],
    ];

    for (const [word, body] of answers) {
      stubFetch(200, body);
      const lookup = await readRecheckStatus(PASSPORT);
      expect(lookup.state, word).toBe("known");
      if (lookup.state === "known") {
        expect(lookup.status.status, word).toBe(word);
      }
    }
  });

  it("reads the transaction and the verdict off a finished request", async () => {
    stubFetch(200, {
      passportId: PASSPORT,
      status: "done",
      requestedAt: 1_790_000_000_000,
      finishedAt: 1_790_000_300_000,
      reportTx: TX,
      matched: false,
      distance: 7,
    });

    const lookup = await readRecheckStatus(PASSPORT);
    if (lookup.state !== "known") {
      throw new Error("a done request came back as something else");
    }
    expect(lookup.status.reportTx).toBe(TX);
    expect(lookup.status.matched).toBe(false);
    expect(lookup.status.distance).toBe(7);
  });

  it("asks the status path for this passport and nothing else", async () => {
    const fetchStub = stubFetch(200, { passportId: PASSPORT, status: "none" });
    await readRecheckStatus(PASSPORT);
    const [url, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://localhost:4010/recheck/status/${PASSPORT}`);
    expect(init.method).toBe("GET");
  });

  it("says none when the service knows of no request", async () => {
    stubFetch(200, { passportId: PASSPORT, status: "none" });
    expect((await readRecheckStatus(PASSPORT)).state).toBe("none");
  });

  it("says none when the service has no queue route yet, because there is still nothing in flight", async () => {
    stubFetch(404, { error: "Not Found" }, false);
    expect((await readRecheckStatus(PASSPORT)).state).toBe("none");
  });

  it("says unknown, never none, when the service will not answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("failed to fetch");
      }),
    );
    expect((await readRecheckStatus(PASSPORT)).state).toBe("unknown");
  });

  it("says unknown for a refusal that is not a missing route", async () => {
    stubFetch(500, { error: "everything is on fire" }, false);
    expect((await readRecheckStatus(PASSPORT)).state).toBe("unknown");
  });

  it("says unknown for an answer that is not JSON and for one in a shape this app does not know", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("not json");
        },
      })),
    );
    expect((await readRecheckStatus(PASSPORT)).state).toBe("unknown");

    stubFetch(200, { passportId: PASSPORT, status: "whenever" });
    expect((await readRecheckStatus(PASSPORT)).state).toBe("unknown");
  });

  it("refuses an answer filed under another passport", async () => {
    stubFetch(200, { passportId: OTHER, status: "pending", requestedAt: 1_790_000_000_000 });
    const lookup = await readRecheckStatus(PASSPORT);
    expect(lookup.state).toBe("unknown");
  });

  it("takes an answer with no passport id in it, which older services may not send", () => {
    expect(recheckStatusSchema.safeParse({ status: "none" }).success).toBe(true);
  });
});
