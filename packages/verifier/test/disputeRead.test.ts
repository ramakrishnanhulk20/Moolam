// Covers the dispute read behind /verify and /verify/paid: the status enum mapping, the two answer
// shapes, the sixty second memory and its cap, the five second timeout, which passports are read,
// and the field itself in each of its shapes on both routes. The chain is a fake transport that
// answers the eth_call viem makes, so the encoding and the decoding are real and the network is not.
// Does NOT cover the registry's own dispute rules, which are the contract's tests, and does not
// cover a live RPC.

import { describe, expect, it, vi } from "vitest";
import { custom, decodeFunctionData, encodeFunctionResult, toHex } from "viem";
import {
  DISPUTE_CACHE_MAX,
  DISPUTE_READ_TIMEOUT_MS,
  DISPUTE_TTL_MS,
  disputeAbi,
  disputeReader,
  withPassportFacts,
  type DisputeCall,
} from "../src/disputeRead.js";
import { offlineConsentReader } from "../src/consentRead.js";
import { fingerprint } from "../src/fingerprint.js";
import { verifyPaidRoutes } from "../src/routes/verifyPaid.js";
import { buildServer } from "../src/server.js";
import { offlinePictureReader } from "../src/unseal.js";
import type { PassportSource } from "../src/source/PassportSource.js";
import type { Hex, PassportRecord } from "../src/types.js";
import { makeImage, multipartBody, recordFor } from "./helpers.js";

const REGISTRY = "0xa19188801E5DC93CD925884d73e4DaFc2bcb80C0" as Hex;
const PASSPORT = "0xcdb25d3755452efa3b746f168cf9cefd3a1b693ab2b81d260a2d64f13d771638" as Hex;
const CHALLENGER = "0xC5ead1E4E5C6d56E87e02317f3fB3731cB0b6Ef7" as Hex;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Hex;
const ZERO_HASH = `0x${"00".repeat(32)}` as Hex;

/** One stored dispute, as the registry holds it. An untouched passport is a zeroed record. */
function record(status: number): { challenger: Hex; bond: bigint; evidenceHash: Hex; status: number; openedAt: bigint } {
  if (status === 0) {
    return { challenger: ZERO_ADDRESS, bond: 0n, evidenceHash: ZERO_HASH, status: 0, openedAt: 0n };
  }
  return { challenger: CHALLENGER, bond: 1_000_000_000_000_000_000n, evidenceHash: ZERO_HASH, status, openedAt: 1_788_880_000n };
}

/** A chain that answers getDispute for the passports it was given and records what it was asked. */
function fakeChain(stored: Record<string, number> = {}): { transport: ReturnType<typeof custom>; asked: Hex[] } {
  const asked: Hex[] = [];
  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      if (method === "eth_chainId") {
        return toHex(143);
      }
      if (method !== "eth_call") {
        throw new Error(`the fake chain was asked for ${method}, which the test does not expect`);
      }
      const request = (params as { to: string; data: Hex }[])[0];
      const decoded = decodeFunctionData({ abi: disputeAbi, data: request?.data ?? "0x" });
      const passportId = (decoded.args as readonly Hex[])[0] as Hex;
      asked.push(passportId);
      return encodeFunctionResult({
        abi: disputeAbi,
        functionName: "getDispute",
        result: record(stored[passportId.toLowerCase()] ?? 0),
      });
    },
  });
  return { transport, asked };
}

function readerFor(stored: Record<string, number>): { read: ReturnType<typeof disputeReader>; asked: Hex[] } {
  const chain = fakeChain(stored);
  return { read: disputeReader({ transport: chain.transport, address: REGISTRY }), asked: chain.asked };
}

function sourceOf(records: PassportRecord[]): PassportSource {
  return { load: async () => records };
}

describe("dispute reader", () => {
  it("maps every value the contract's enum can hold onto its own word", async () => {
    const words = ["none", "open", "upheld", "rejected"];
    for (const [value, word] of words.entries()) {
      const { read } = readerFor({ [PASSPORT]: value });

      expect(await read.answerFor(PASSPORT), word).toEqual({ source: "chain", status: word });
    }
  });

  it("answers none for a passport nobody has challenged", async () => {
    const { read } = readerFor({});

    expect(await read.answerFor(PASSPORT)).toEqual({ source: "chain", status: "none" });
  });

  it("treats a status the enum has no room for as a failed read rather than guessing at it", async () => {
    const { read } = readerFor({ [PASSPORT]: 4 });

    expect(await read.answerFor(PASSPORT)).toEqual({ source: "unavailable" });
  });

  it("answers unavailable when the read throws, and never rejects", async () => {
    const read = disputeReader({
      call: () => {
        throw new Error("the RPC refused the call");
      },
    });

    expect(await read.answerFor(PASSPORT)).toEqual({ source: "unavailable" });
  });

  it("gives up on a read that runs past the five second limit", async () => {
    vi.useFakeTimers();
    try {
      const read = disputeReader({ call: () => new Promise(() => undefined) });
      const answer = read.answerFor(PASSPORT);

      await vi.advanceTimersByTimeAsync(DISPUTE_READ_TIMEOUT_MS);

      expect(await answer).toEqual({ source: "unavailable" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("serves the next minute from memory and asks the chain again once it is up", async () => {
    vi.useFakeTimers();
    try {
      const { read, asked } = readerFor({ [PASSPORT]: 2 });

      expect(await read.answerFor(PASSPORT)).toEqual({ source: "chain", status: "upheld" });
      expect(await read.answerFor(PASSPORT)).toEqual({ source: "chain", status: "upheld" });
      expect(asked).toHaveLength(1);

      vi.advanceTimersByTime(DISPUTE_TTL_MS);
      expect(await read.answerFor(PASSPORT)).toEqual({ source: "chain", status: "upheld" });

      expect(asked).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("forgets the oldest passport when it is holding as many as it may", async () => {
    const asked: Hex[] = [];
    const call: DisputeCall = async (passportId) => {
      asked.push(passportId);
      return record(0);
    };
    const read = disputeReader({ call, maxEntries: 2 });
    const ids = [1, 2, 3].map((byte) => `0x${byte.toString(16).padStart(2, "0").repeat(32)}` as Hex);

    for (const id of ids) {
      await read.answerFor(id);
    }
    // The third arrival pushed the first out, so it costs a read; the third is still in memory.
    await read.answerFor(ids[2] as Hex);
    await read.answerFor(ids[0] as Hex);

    expect(asked).toEqual([ids[0], ids[1], ids[2], ids[0]]);
  });

  it("holds two thousand passports for sixty seconds by default", () => {
    expect(DISPUTE_CACHE_MAX).toBe(2_000);
    expect(DISPUTE_TTL_MS).toBe(60_000);
    expect(DISPUTE_READ_TIMEOUT_MS).toBe(5_000);
  });

  // Through withPassportFacts, the one walker both verify routes call. The thin withDispute that
  // used to sit here had no caller in the service and is gone; what it proved lives here.
  it("attaches the status to the exact passport and the best match, and to nothing else in the list", async () => {
    const other = `0x${"ab".repeat(32)}` as Hex;
    const third = `0x${"cd".repeat(32)}` as Hex;
    const { read, asked } = readerFor({ [PASSPORT]: 0, [other]: 1 });

    const payload = await withPassportFacts(
      {
        result: {
          exact: PASSPORT,
          best: { id: other, score: 0.9 },
          matches: [{ id: other, score: 0.9 }, { id: third, score: 0.4 }],
        },
        manifest: { present: false },
      },
      offlineConsentReader(),
      read,
      () => undefined,
      offlinePictureReader(),
    );

    const result = payload.result as unknown as {
      best: { dispute: unknown };
      matches: { id: Hex; dispute?: unknown }[];
    };
    expect(asked.map((id) => id.toLowerCase())).toEqual([PASSPORT, other]);
    expect(result.best.dispute).toEqual({ source: "chain", status: "open" });
    expect(result.matches[0]?.dispute).toEqual({ source: "chain", status: "open" });
    expect(result.matches[1]).not.toHaveProperty("dispute");
  });
});

describe("the dispute field on the verify routes", () => {
  it("returns each status the chain can hold beside a match, and unavailable when the read fails", async () => {
    const registered = await makeImage(81);
    const print = await fingerprint(registered);
    const shapes: { status: number | "failed"; expected: unknown }[] = [
      { status: 0, expected: { source: "chain", status: "none" } },
      { status: 1, expected: { source: "chain", status: "open" } },
      { status: 2, expected: { source: "chain", status: "upheld" } },
      { status: 3, expected: { source: "chain", status: "rejected" } },
      { status: "failed", expected: { source: "unavailable" } },
    ];

    for (const shape of shapes) {
      const what = String(shape.status);
      const record_ = recordFor(print);
      const read =
        shape.status === "failed"
          ? disputeReader({
              call: () => {
                throw new Error("the RPC refused the call");
              },
            })
          : readerFor({ [record_.id]: shape.status }).read;
      const app = await buildServer({ source: sourceOf([record_]), logger: false, dispute: read });
      await app.ready();

      try {
        const { payload, headers } = multipartBody("file", "a.jpg", "image/jpeg", registered);
        const response = await app.inject({ method: "POST", url: "/verify", payload, headers });

        expect(response.statusCode, what).toBe(200);
        const body = response.json();
        expect(body.result.exact, what).toBe(record_.id);
        expect(body.result.best.dispute, what).toEqual(shape.expected);
      } finally {
        await app.close();
      }
    }
  });

  it("returns the same field on the paid route, in the body the payment is settled over", async () => {
    const image = await makeImage(82);
    const passport = recordFor(await fingerprint(image));
    const { read } = readerFor({ [passport.id]: 2 });
    const settle = vi.fn(async (_payload: unknown, _requirements: unknown, _extensions: unknown, context: unknown) => ({
      success: true,
      errorReason: "",
      transaction: "0x4a",
      headers: {},
      response: { status: 200, headers: {}, body: {} },
      seen: (context as { responseBody: Buffer }).responseBody.toString("utf8"),
    }));
    const payments = {
      initialize: async () => undefined,
      processHTTPRequest: async () => ({
        type: "payment-verified",
        paymentPayload: {},
        paymentRequirements: {},
        declaredExtensions: [],
        cancellationDispatcher: { cancel: async () => undefined },
      }),
      processSettlement: settle,
    } as unknown as Parameters<typeof verifyPaidRoutes>[1]["payments"];

    const app = await buildServer({ source: sourceOf([passport]), logger: false, dispute: read });
    await app.register(verifyPaidRoutes, { payments });
    await app.ready();

    try {
      const { payload, headers } = multipartBody("file", "a.jpg", "image/jpeg", image);
      const response = await app.inject({ method: "POST", url: "/verify/paid", payload, headers });

      expect(response.statusCode).toBe(200);
      expect(response.json().result.best.dispute).toEqual({ source: "chain", status: "upheld" });
      expect(await settle.mock.results[0]?.value).toMatchObject({
        seen: expect.stringContaining('"dispute":{"source":"chain","status":"upheld"}') as unknown as string,
      });
    } finally {
      await app.close();
    }
  });

  it("carries no dispute field when nothing matched, because there is no passport to ask about", async () => {
    const registered = await makeImage(83);
    const passport = recordFor(await fingerprint(registered));
    const { read, asked } = readerFor({});
    const app = await buildServer({ source: sourceOf([passport]), logger: false, dispute: read });
    await app.ready();

    try {
      const { payload, headers } = multipartBody("file", "b.jpg", "image/jpeg", await makeImage(84));
      const response = await app.inject({ method: "POST", url: "/verify", payload, headers });

      expect(response.statusCode).toBe(200);
      expect(response.json().result.best).toBeNull();
      expect(asked).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});
