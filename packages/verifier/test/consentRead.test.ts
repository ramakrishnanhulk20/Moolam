// Covers the consent read behind /verify and /verify/paid: the enum mapping, the three answer
// shapes, the constraint text checked on the way out, the sixty second memory and its cap, the
// five second timeout, and both routes still answering 200 with a full match when the read fails.
// The chain is a fake transport that answers the eth_call viem makes, so the encoding and the
// decoding are real and the network is not.
// Does NOT cover the deployed contract's own rules, which are the contract's tests, and does not
// cover a live RPC: live /verify answers carrying the consent read on Monad mainnet are quoted in
// proofs/consent-statements.txt.

import { describe, expect, it, vi } from "vitest";
import { custom, decodeFunctionData, encodeAbiParameters, toHex } from "viem";
import {
  CONSENT_CACHE_MAX,
  CONSENT_READ_TIMEOUT_MS,
  CONSENT_TTL_MS,
  consentAbi,
  consentReader,
  type ConsentCall,
} from "../src/consentRead.js";
import { offlineDisputeReader, withPassportFacts } from "../src/disputeRead.js";
import { fingerprint } from "../src/fingerprint.js";
import { verifyPaidRoutes } from "../src/routes/verifyPaid.js";
import { buildServer } from "../src/server.js";
import { offlinePictureReader } from "../src/unseal.js";
import type { PassportSource } from "../src/source/PassportSource.js";
import type { Hex, PassportRecord } from "../src/types.js";
import { makeImage, multipartBody, recordFor } from "./helpers.js";

const CONSENT_ADDRESS = "0x1151E69a82947920546e779c4C8c785b2a3C1277" as Hex;
const PASSPORT = "0xcdb25d3755452efa3b746f168cf9cefd3a1b693ab2b81d260a2d64f13d771638" as Hex;
const HOLDER = "0xC5ead1E4E5C6d56E87e02317f3fB3731cB0b6Ef7" as Hex;

interface Entry {
  at: bigint;
  writer: Hex;
  consent: { aiTraining: number; aiGenerativeTraining: number; aiInference: number; dataMining: number };
  constraintInfo: string;
}

function entry(values: [number, number, number, number], constraintInfo = ""): Entry {
  return {
    at: 1_788_880_000n,
    writer: HOLDER,
    consent: {
      aiTraining: values[0],
      aiGenerativeTraining: values[1],
      aiInference: values[2],
      dataMining: values[3],
    },
    constraintInfo,
  };
}

const NOTHING: Entry = entry([0, 0, 0, 0]);

/** A chain that answers consentOf for the passports it was given and records what it was asked. */
function fakeChain(stored: Record<string, Entry> = {}): { transport: ReturnType<typeof custom>; asked: Hex[] } {
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
      const decoded = decodeFunctionData({ abi: consentAbi, data: request?.data ?? "0x" });
      const passportId = (decoded.args as readonly Hex[])[0] as Hex;
      asked.push(passportId);
      const held = stored[passportId.toLowerCase()];
      return encodeAbiParameters(consentAbi[0].outputs, [held !== undefined, held ?? NOTHING]);
    },
  });
  return { transport, asked };
}

function readerFor(stored: Record<string, Entry>): { read: ReturnType<typeof consentReader>; asked: Hex[] } {
  const chain = fakeChain(stored);
  return { read: consentReader({ transport: chain.transport, address: CONSENT_ADDRESS }), asked: chain.asked };
}

function sourceOf(records: PassportRecord[]): PassportSource {
  return { load: async () => records };
}

describe("consent reader", () => {
  it("maps every value the contract's enum can hold onto its own word", async () => {
    const words = ["unspecified", "allowed", "notAllowed", "constrained"];
    for (const [value, word] of words.entries()) {
      const info = word === "constrained" ? "write to hello@moolam.app" : "";
      const { read } = readerFor({ [PASSPORT]: entry([value, value, value, value], info) });

      const answer = await read.answerFor(PASSPORT);

      expect(answer, word).toMatchObject({
        source: "chain",
        stated: true,
        aiTraining: word,
        aiGenerativeTraining: word,
        aiInference: word,
        dataMining: word,
      });
    }
  });

  it("reads a statement with a different word in each field, its text, its date and its writer", async () => {
    const { read } = readerFor({ [PASSPORT]: entry([2, 3, 1, 0], "ask hello@moolam.app") });

    expect(await read.answerFor(PASSPORT)).toEqual({
      source: "chain",
      stated: true,
      standard: "cawg.training-mining/1.1",
      aiTraining: "notAllowed",
      aiGenerativeTraining: "constrained",
      aiInference: "allowed",
      dataMining: "unspecified",
      constraintInfo: "ask hello@moolam.app",
      at: 1_788_880_000,
      writer: HOLDER,
    });
  });

  it("answers stated false for a passport whose holder has never spoken", async () => {
    const { read } = readerFor({});

    expect(await read.answerFor(PASSPORT)).toEqual({ source: "chain", stated: false });
  });

  it("treats a value the enum has no room for as a failed read rather than guessing at it", async () => {
    const { read } = readerFor({ [PASSPORT]: entry([1, 4, 1, 1]) });

    expect(await read.answerFor(PASSPORT)).toEqual({ source: "unavailable" });
  });

  it("drops constraint text that is over the contract's limit or is not printable, and keeps the statement", async () => {
    const tooLong = "x".repeat(257);
    const notPrintable = "ask\nhello@moolam.app";

    for (const info of [tooLong, notPrintable]) {
      const { read } = readerFor({ [PASSPORT]: entry([3, 3, 3, 3], info) });

      const answer = await read.answerFor(PASSPORT);

      expect(answer).toMatchObject({ source: "chain", stated: true, aiTraining: "constrained" });
      expect(answer).not.toHaveProperty("constraintInfo");
    }
  });

  it("answers unavailable when the read throws, and never rejects", async () => {
    const read = consentReader({
      call: () => {
        throw new Error("the RPC refused the call");
      },
    });

    expect(await read.answerFor(PASSPORT)).toEqual({ source: "unavailable" });
  });

  it("gives up on a read that runs past the five second limit", async () => {
    vi.useFakeTimers();
    try {
      const read = consentReader({ call: () => new Promise(() => undefined) });
      const answer = read.answerFor(PASSPORT);

      await vi.advanceTimersByTimeAsync(CONSENT_READ_TIMEOUT_MS);

      expect(await answer).toEqual({ source: "unavailable" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("serves the next minute from memory and asks the chain again once it is up", async () => {
    vi.useFakeTimers();
    try {
      const { read, asked } = readerFor({ [PASSPORT]: entry([2, 2, 2, 2]) });

      expect(await read.answerFor(PASSPORT)).toMatchObject({ stated: true });
      expect(await read.answerFor(PASSPORT)).toMatchObject({ stated: true });
      expect(asked).toHaveLength(1);

      vi.advanceTimersByTime(CONSENT_TTL_MS);
      expect(await read.answerFor(PASSPORT)).toMatchObject({ stated: true });

      expect(asked).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("forgets the oldest passport when it is holding as many as it may", async () => {
    const asked: Hex[] = [];
    const call: ConsentCall = async (passportId) => {
      asked.push(passportId);
      return [true, entry([1, 1, 1, 1])] as const;
    };
    const read = consentReader({ call, maxEntries: 2 });
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
    expect(CONSENT_CACHE_MAX).toBe(2_000);
    expect(CONSENT_TTL_MS).toBe(60_000);
    expect(CONSENT_READ_TIMEOUT_MS).toBe(5_000);
  });

  // Through withPassportFacts, the one walker both verify routes call. The thin withConsent that
  // used to sit here had no caller in the service and is gone; what it proved lives here.
  it("attaches the statement to the exact passport and the best match, and to nothing else in the list", async () => {
    const other = `0x${"ab".repeat(32)}` as Hex;
    const third = `0x${"cd".repeat(32)}` as Hex;
    const { read, asked } = readerFor({ [PASSPORT]: entry([2, 2, 2, 2]), [other]: entry([1, 1, 1, 1]) });

    const payload = await withPassportFacts(
      {
        result: {
          exact: PASSPORT,
          best: { id: other, score: 0.9 },
          matches: [{ id: other, score: 0.9 }, { id: third, score: 0.4 }],
        },
        manifest: { present: false },
      },
      read,
      offlineDisputeReader(),
      () => undefined,
      offlinePictureReader(),
    );

    const result = payload.result as unknown as {
      best: { consent: unknown };
      matches: { id: Hex; consent?: unknown }[];
    };
    // Two reads for an answer holding three candidates: the exact passport and the best match.
    expect(asked.map((id) => id.toLowerCase())).toEqual([PASSPORT, other]);
    expect(result.best.consent).toMatchObject({ source: "chain", aiTraining: "allowed" });
    expect(result.matches[0]?.consent).toMatchObject({ source: "chain", aiTraining: "allowed" });
    expect(result.matches[1]).not.toHaveProperty("consent");
  });
});

describe("consent on the verify routes", () => {
  it("returns the statement beside an exact match", async () => {
    const registered = await makeImage(71);
    const record = recordFor(await fingerprint(registered));
    const { read, asked } = readerFor({ [record.id]: entry([2, 2, 1, 3], "licence at moolam.app/terms") });
    const app = await buildServer({ source: sourceOf([record]), logger: false, consent: read });
    await app.ready();

    try {
      const { payload, headers } = multipartBody("file", "a.jpg", "image/jpeg", registered);
      const response = await app.inject({ method: "POST", url: "/verify", payload, headers });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.result.exact).toBe(record.id);
      expect(body.result.best.consent).toEqual({
        source: "chain",
        stated: true,
        standard: "cawg.training-mining/1.1",
        aiTraining: "notAllowed",
        aiGenerativeTraining: "notAllowed",
        aiInference: "allowed",
        dataMining: "constrained",
        constraintInfo: "licence at moolam.app/terms",
        at: 1_788_880_000,
        writer: HOLDER,
      });
      // The exact match and the best match are the same passport, so it is read once.
      expect(asked).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("still answers 200 with the whole match when the chain read throws or times out", async () => {
    const registered = await makeImage(72);
    const record = recordFor(await fingerprint(registered));
    const readers = {
      throws: consentReader({
        call: () => {
          throw new Error("the RPC refused the call");
        },
      }),
      "times out": consentReader({ call: () => new Promise(() => undefined), timeoutMs: 10 }),
    };

    for (const [what, read] of Object.entries(readers)) {
      const app = await buildServer({ source: sourceOf([record]), logger: false, consent: read });
      await app.ready();

      try {
        const { payload, headers } = multipartBody("file", "a.jpg", "image/jpeg", registered);
        const response = await app.inject({ method: "POST", url: "/verify", payload, headers });

        expect(response.statusCode, what).toBe(200);
        const body = response.json();
        expect(body.result.exact, what).toBe(record.id);
        expect(body.result.confidence, what).toBe(1);
        expect(typeof body.result.queried.phash, what).toBe("string");
        expect(body.manifest.present, what).toBe(false);
        expect(body.result.best.consent, what).toEqual({ source: "unavailable" });
      } finally {
        await app.close();
      }
    }
  });

  it("returns the same field on the paid route, in the body the payment is settled over", async () => {
    const image = await makeImage(75);
    const record = recordFor(await fingerprint(image));
    const { read } = readerFor({ [record.id]: entry([2, 2, 2, 2]) });
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

    const app = await buildServer({ source: sourceOf([record]), logger: false, consent: read });
    await app.register(verifyPaidRoutes, { payments });
    await app.ready();

    try {
      const { payload, headers } = multipartBody("file", "a.jpg", "image/jpeg", image);
      const response = await app.inject({ method: "POST", url: "/verify/paid", payload, headers });

      expect(response.statusCode).toBe(200);
      expect(response.json().result.best.consent).toMatchObject({ source: "chain", stated: true });
      expect(await settle.mock.results[0]?.value).toMatchObject({
        seen: expect.stringContaining('"consent":{"source":"chain"') as unknown as string,
      });
    } finally {
      await app.close();
    }
  });

  it("carries no consent field when nothing matched, because there is no passport to ask about", async () => {
    const registered = await makeImage(73);
    const record = recordFor(await fingerprint(registered));
    const { read, asked } = readerFor({});
    const app = await buildServer({ source: sourceOf([record]), logger: false, consent: read });
    await app.ready();

    try {
      const { payload, headers } = multipartBody("file", "b.jpg", "image/jpeg", await makeImage(74));
      const response = await app.inject({ method: "POST", url: "/verify", payload, headers });

      expect(response.statusCode).toBe(200);
      expect(response.json().result.best).toBeNull();
      expect(asked).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});
