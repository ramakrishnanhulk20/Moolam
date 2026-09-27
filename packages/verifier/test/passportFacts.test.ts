// Covers withPassportFacts, the one function both verify routes call to attach the consent
// statement, the dispute status, the re-check fact and the picture state together: the same passport in both the exact and best slot
// costs one read of each rather than two, every read for two different matches has started before
// the first one gives up (so a dead chain costs one timeout, not several in turn), and the key
// order a caller sees is unchanged. The "started together" tests look at the order of events and
// never at a clock: an earlier version timed the call against 1.5 timeouts and failed whenever the
// machine was busy, which measured the machine and not the code.
// The chain here is a plain stub function, not a fake transport, because the eth_call encoding is
// already covered by consentRead.test.ts and disputeRead.test.ts; this file is about the ordering
// of the reads, not the reads themselves.
// The picture state is read through the real pictureReader with its document reader and unseal
// record finder stubbed: each of its four answers on a /verify and a /verify/paid answer, a finder
// that throws, a reader that breaks its promise, a read slower than its bound, and its memory,
// where "sealed" is held ten seconds at most and every fact says when it was read (pass 6, V46),
// and a slow "sealed" read never replaces a newer "unsealed" (pass 11, V113).
// From review pass 4 (V18): the first registration, when it is not the best or exact match,
// carries the same four facts, read the same way, and no more than three passports are read.
// Does NOT cover the enum mapping, the consent and dispute caches, or each chain reader's own
// timeout in isolation, which are consentRead.test.ts and disputeRead.test.ts; pictureStateOf's own
// cases are test/pictureState.test.ts. It does not cover a live RPC, gateway or Pinata.

import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { consentReader, type ConsentCall } from "../src/consentRead.js";
import { disputeReader, withPassportFacts, type DisputeCall } from "../src/disputeRead.js";
import { fingerprint } from "../src/fingerprint.js";
import { verifyPaidRoutes } from "../src/routes/verifyPaid.js";
import { buildServer } from "../src/server.js";
import type { PassportSource } from "../src/source/PassportSource.js";
import type { Hex, PassportRecord } from "../src/types.js";
import {
  offlinePictureReader,
  pictureReader,
  unsealRecord,
  type DocumentReader,
  type PictureReader,
  type UnsealRecordFinder,
} from "../src/unseal.js";
import { makeImage, multipartBody, recordFor } from "./helpers.js";

const HOLDER = "0xC5ead1E4E5C6d56E87e02317f3fB3731cB0b6Ef7" as Hex;
const RECHECKER = "0x0d69055c43eacb3b1ca687ca2263a049bc7eff04" as Hex;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Hex;
const ZERO_HASH = `0x${"00".repeat(32)}` as Hex;
/** Every fact read from its source says when, in unix seconds (review pass 6, V46). */
const READ_AT = expect.any(Number) as unknown as number;

function sourceOf(records: PassportRecord[]): PassportSource {
  return { load: async () => records };
}

/**
 * Two readers whose chain calls never answer, and a log of what happened in what order. A read
 * that was started says so at once; a consent read that gave up says so when its timeout fires.
 * Reads started together put every "start" ahead of the first "gave up"; reads waited through in
 * turn cannot, because the dispute reads would only start after the consent reads had given up.
 */
function hangingReaders(timeoutMs: number) {
  const order: string[] = [];
  const consentCall: ConsentCall = () => {
    order.push("consent start");
    return new Promise(() => undefined);
  };
  const disputeCall: DisputeCall = () => {
    order.push("dispute start");
    return new Promise(() => undefined);
  };
  const inner = consentReader({ call: consentCall, timeoutMs });
  const consent = {
    answerFor: async (id: string) => {
      const answer = await inner.answerFor(id);
      order.push("consent gave up");
      return answer;
    },
  };
  return { order, consent, dispute: disputeReader({ call: disputeCall, timeoutMs }) };
}

function startedTogether(order: string[], reads: number): void {
  const firstGaveUp = order.indexOf("consent gave up");
  expect(firstGaveUp).toBeGreaterThan(-1);
  const startsBefore = order.slice(0, firstGaveUp).filter((entry) => entry.endsWith("start"));
  expect(startsBefore).toHaveLength(reads);
}

describe("withPassportFacts", () => {
  it("reads the same passport once for consent and once for dispute when the exact and best match are the same, consent first", async () => {
    const consentAsked: Hex[] = [];
    const disputeAsked: Hex[] = [];
    const passport = `0x${"33".repeat(32)}` as Hex;

    const consentCall: ConsentCall = async (id) => {
      consentAsked.push(id);
      return [
        true,
        {
          at: 1_700_000_000n,
          writer: HOLDER,
          consent: { aiTraining: 1, aiGenerativeTraining: 1, aiInference: 1, dataMining: 1 },
          constraintInfo: "",
        },
      ] as const;
    };
    const disputeCall: DisputeCall = async (id) => {
      disputeAsked.push(id);
      return { challenger: ZERO_ADDRESS, bond: 0n, evidenceHash: ZERO_HASH, status: 0, openedAt: 0n };
    };

    const payload = await withPassportFacts(
      {
        result: { exact: passport, best: { id: passport, score: 1 }, matches: [{ id: passport, score: 1 }] },
        manifest: { present: false },
      },
      consentReader({ call: consentCall }),
      disputeReader({ call: disputeCall }),
      () => undefined,
      offlinePictureReader(),
    );

    expect(consentAsked).toEqual([passport]);
    expect(disputeAsked).toEqual([passport]);

    const best = (payload.result as unknown as { best: Record<string, unknown> }).best;
    expect(best.consent).toMatchObject({ source: "chain", stated: true });
    expect(best.dispute).toEqual({ source: "chain", status: "none", readAt: READ_AT });
    // The two used to be attached by one call after another, consent then dispute; a caller reading
    // the object's own key order must see that same order today.
    expect(Object.keys(best).indexOf("consent")).toBeLessThan(Object.keys(best).indexOf("dispute"));
  });

  it("has started every read for two different matches before the first one gives up", async () => {
    const { order, consent, dispute } = hangingReaders(50);
    const exact = `0x${"11".repeat(32)}` as Hex;
    const other = `0x${"22".repeat(32)}` as Hex;

    const payload = await withPassportFacts(
      {
        result: {
          exact,
          best: { id: other, score: 0.9 },
          matches: [{ id: exact, score: 1 }, { id: other, score: 0.9 }],
        },
        manifest: { present: false },
      },
      consent,
      dispute,
      () => undefined,
      offlinePictureReader(),
    );

    // Two passports, two facts each: four reads, all under way before any timeout fired.
    startedTogether(order, 4);

    const result = payload.result as unknown as { matches: Record<string, unknown>[] };
    for (const match of result.matches) {
      expect(match.consent).toEqual({ source: "unavailable" });
      expect(match.dispute).toEqual({ source: "unavailable" });
    }
  });

  it("loses only the fact whose reader failed, never the other two", async () => {
    const passport = `0x${"55".repeat(32)}` as Hex;
    const record = recordFor(
      { sha256: passport, phash: 9n, blockhash: ZERO_HASH, width: 64, height: 64, format: "jpeg" },
      {
        rechecks: {
          attestations: 1,
          matched: 1,
          mismatched: 0,
          latest: { receiver: RECHECKER, matched: true, distance: 0, at: 1_789_368_639 },
        },
      },
    );
    const stated: ConsentCall = async () =>
      [
        true,
        {
          at: 1_700_000_000n,
          writer: HOLDER,
          consent: { aiTraining: 2, aiGenerativeTraining: 2, aiInference: 1, dataMining: 1 },
          constraintInfo: "",
        },
      ] as const;
    const answer = { result: { exact: passport, best: { id: passport, score: 1 }, matches: [] }, manifest: {} };

    // A chain call that answers with something the reader cannot read. Reading the status used to
    // sit outside the reader's own try, so this threw past the walker and took all three facts.
    const unreadable = await withPassportFacts(
      answer,
      consentReader({ call: stated }),
      disputeReader({ call: (async () => undefined) as unknown as DisputeCall }),
      (id) => (id === passport ? record : undefined),
      offlinePictureReader(),
    );

    // A reader that breaks its promise and rejects outright, which the walker guards separately.
    const broken = await withPassportFacts(
      answer,
      consentReader({ call: stated }),
      {
        answerFor: async () => {
          throw new Error("the dispute reader fell over");
        },
      },
      (id) => (id === passport ? record : undefined),
      offlinePictureReader(),
    );

    for (const [what, payload] of [["unreadable", unreadable], ["broken", broken]] as const) {
      const best = (payload.result as unknown as { best: Record<string, unknown> }).best;
      expect(best.dispute, what).toEqual({ source: "unavailable" });
      expect(best.consent, what).toMatchObject({ source: "chain", stated: true, aiTraining: "notAllowed" });
      expect(best.recheck, what).toMatchObject({ source: "index", attestations: 1, matched: 1 });
      expect(Object.keys(best), what).toEqual(["id", "score", "consent", "dispute", "inheritedDispute", "recheck", "picture"]);
    }
  });
});

describe("both facts on the verify routes, read together", () => {
  it("starts both chain reads for a /verify answer before either gives up", async () => {
    const registered = await makeImage(91);
    const record = recordFor(await fingerprint(registered));
    const { order, consent, dispute } = hangingReaders(50);
    const app = await buildServer({ source: sourceOf([record]), logger: false, consent, dispute });
    await app.ready();

    try {
      const { payload, headers } = multipartBody("file", "a.jpg", "image/jpeg", registered);
      const response = await app.inject({ method: "POST", url: "/verify", payload, headers });

      expect(response.statusCode).toBe(200);
      // One passport in both slots: one consent read and one dispute read, started together.
      startedTogether(order, 2);
      const body = response.json();
      expect(body.result.best.consent).toEqual({ source: "unavailable" });
      expect(body.result.best.dispute).toEqual({ source: "unavailable" });
    } finally {
      await app.close();
    }
  });

  it("carries both fields together in the body /verify/paid settles over", async () => {
    const image = await makeImage(92);
    const record = recordFor(await fingerprint(image));
    const consent = consentReader({
      call: async () =>
        [
          true,
          {
            at: 1_700_000_000n,
            writer: HOLDER,
            consent: { aiTraining: 1, aiGenerativeTraining: 1, aiInference: 1, dataMining: 1 },
            constraintInfo: "",
          },
        ] as const,
    });
    const dispute = disputeReader({
      call: async () => ({ challenger: ZERO_ADDRESS, bond: 0n, evidenceHash: ZERO_HASH, status: 1, openedAt: 0n }),
    });
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

    const app = await buildServer({ source: sourceOf([record]), logger: false, consent, dispute });
    await app.register(verifyPaidRoutes, { payments });
    await app.ready();

    try {
      const { payload, headers } = multipartBody("file", "a.jpg", "image/jpeg", image);
      const response = await app.inject({ method: "POST", url: "/verify/paid", payload, headers });

      expect(response.statusCode).toBe(200);
      expect(response.json().result.best).toMatchObject({
        consent: { source: "chain", stated: true },
        dispute: { source: "chain", status: "open" },
      });
      const settled = (await settle.mock.results[0]?.value) as { seen: string };
      expect(settled.seen.indexOf('"consent"')).toBeLessThan(settled.seen.indexOf('"dispute"'));
    } finally {
      await app.close();
    }
  });
});

/** A payment server that always verifies and settles, recording the body it settled over. */
function paidStub() {
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
  return { payments, settle };
}

const UNSEALED_AT = "2026-09-22T12:27:28.000Z";
const SEALED_DOCUMENT = { name: "a sealed picture", sealed: true };

function recordOf(passportId: Hex): ReturnType<typeof unsealRecord> {
  return unsealRecord({
    passportId,
    image: "ipfs://bafyimage",
    thumbnail: "ipfs://bafythumb",
    unsealedBy: HOLDER,
    unsealedAt: new Date(UNSEALED_AT),
  });
}

describe("the picture state on the verify routes", () => {
  it("says public, sealed, unsealed with its time, or unavailable, on /verify and /verify/paid alike", async () => {
    const states = ["public", "sealed", "unsealed", "unavailable"] as const;
    const images = new Map<string, Buffer>();
    const records: PassportRecord[] = [];
    for (const [index, state] of states.entries()) {
      const image = await makeImage(93 + index);
      images.set(state, image);
      records.push(recordFor(await fingerprint(image), { metadataURI: `ipfs://bafy${state}document` }));
    }
    const unsealedId = records[2]?.id as Hex;
    const readDocument: DocumentReader = async (uri) => {
      if (uri === "ipfs://bafypublicdocument") return { name: "a picture", image: "ipfs://bafyimage" };
      if (uri === "ipfs://bafyunavailabledocument") throw new Error("the gateway answered 504");
      return SEALED_DOCUMENT;
    };
    const findRecord: UnsealRecordFinder = async (id) => (id === unsealedId ? recordOf(id) : undefined);
    const expected = {
      public: { state: "public", readAt: READ_AT },
      sealed: { state: "sealed", readAt: READ_AT },
      unsealed: { state: "unsealed", at: UNSEALED_AT, readAt: READ_AT },
      unavailable: { source: "unavailable" },
    };

    const { payments, settle } = paidStub();
    const app = await buildServer({
      source: sourceOf(records),
      logger: false,
      picture: pictureReader({ readDocument, findRecord }),
    });
    await app.register(verifyPaidRoutes, { payments });
    await app.ready();

    try {
      for (const [index, state] of states.entries()) {
        for (const url of ["/verify", "/verify/paid"]) {
          const { payload, headers } = multipartBody("file", "a.jpg", "image/jpeg", images.get(state) as Buffer);
          const response = await app.inject({ method: "POST", url, payload, headers });

          expect(response.statusCode, `${state} ${url}`).toBe(200);
          const body = response.json();
          expect(body.result.exact, `${state} ${url}`).toBe(records[index]?.id);
          expect(body.result.best.picture, `${state} ${url}`).toEqual(expected[state]);
          // The state goes out and the address the answer came from does not.
          expect(response.body, `${state} ${url}`).not.toContain("ipfs://");
        }
      }
      // The body the payment settled over carries the same fact the payer was served.
      const settled = (await settle.mock.results[1]?.value) as { seen: string };
      expect(JSON.parse(settled.seen).result.best.picture).toEqual(expected.sealed);
    } finally {
      await app.close();
    }
  }, 60_000);

  it("loses only the picture when the unseal lookup throws, and keeps consent, dispute and recheck", async () => {
    const image = await makeImage(97);
    const record = recordFor(await fingerprint(image), {
      metadataURI: "ipfs://bafysealeddocument",
      rechecks: {
        attestations: 1,
        matched: 1,
        mismatched: 0,
        latest: { receiver: RECHECKER, matched: true, distance: 0, at: 1_789_368_639 },
      },
    });
    const consent = consentReader({
      call: async () =>
        [
          true,
          {
            at: 1_700_000_000n,
            writer: HOLDER,
            consent: { aiTraining: 2, aiGenerativeTraining: 2, aiInference: 1, dataMining: 1 },
            constraintInfo: "",
          },
        ] as const,
    });
    const dispute = disputeReader({
      call: async () => ({ challenger: ZERO_ADDRESS, bond: 0n, evidenceHash: ZERO_HASH, status: 0, openedAt: 0n }),
    });
    const picture = pictureReader({
      readDocument: async () => SEALED_DOCUMENT,
      findRecord: async () => {
        throw new Error("Pinata answered 500 to the record lookup");
      },
    });

    const app = await buildServer({ source: sourceOf([record]), logger: false, consent, dispute, picture });
    await app.ready();
    try {
      const { payload, headers } = multipartBody("file", "a.jpg", "image/jpeg", image);
      const response = await app.inject({ method: "POST", url: "/verify", payload, headers });

      expect(response.statusCode).toBe(200);
      const best = response.json().result.best;
      expect(best.picture).toEqual({ source: "unavailable" });
      expect(best.consent).toMatchObject({ source: "chain", stated: true, aiTraining: "notAllowed" });
      expect(best.dispute).toEqual({ source: "chain", status: "none", readAt: READ_AT });
      expect(best.recheck).toMatchObject({ source: "index", attestations: 1, matched: 1 });
    } finally {
      await app.close();
    }

    // A picture reader that breaks its own promise and rejects is guarded the same way.
    const broken: PictureReader = {
      answerFor: async () => {
        throw new Error("the picture reader fell over");
      },
    };
    const walked = await withPassportFacts(
      { result: { exact: record.id, best: { id: record.id, score: 1 }, matches: [] }, manifest: {} },
      consent,
      dispute,
      (id) => (id === record.id ? record : undefined),
      broken,
    );
    const walkedBest = (walked.result as unknown as { best: Record<string, unknown> }).best;
    expect(walkedBest.picture).toEqual({ source: "unavailable" });
    expect(walkedBest.consent).toMatchObject({ source: "chain", stated: true });
    expect(walkedBest.recheck).toMatchObject({ source: "index", attestations: 1 });
  }, 60_000);

  it("gives up on a picture read that outlasts its bound, and answers unavailable", async () => {
    const reader = pictureReader({
      readDocument: () => new Promise(() => undefined),
      findRecord: async () => undefined,
      timeoutMs: 50,
    });
    expect(await reader.answerFor({ id: `0x${"77".repeat(32)}` as Hex, metadataURI: "ipfs://bafyslow" })).toEqual({
      source: "unavailable",
    });
    expect(await reader.answerFor(undefined)).toEqual({ source: "unavailable" });
  });

  it("keeps public and unsealed for good, asks again about sealed after a minute, and never keeps a failure", async () => {
    const reads: string[] = [];
    const published = new Set<Hex>();
    let gatewayUp = false;
    const readDocument: DocumentReader = async (uri) => {
      reads.push(uri);
      if (!gatewayUp) throw new Error("the gateway answered 504");
      return uri === "ipfs://bafypublic" ? { name: "a picture" } : SEALED_DOCUMENT;
    };
    const findRecord: UnsealRecordFinder = async (id) => (published.has(id) ? recordOf(id) : undefined);
    const reader = pictureReader({ readDocument, findRecord });
    const publicOne = { id: `0x${"81".repeat(32)}` as Hex, metadataURI: "ipfs://bafypublic" };
    const sealedOne = { id: `0x${"82".repeat(32)}` as Hex, metadataURI: "ipfs://bafysealed" };

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      expect(await reader.answerFor(publicOne)).toEqual({ source: "unavailable" });
      gatewayUp = true;
      expect(await reader.answerFor(publicOne)).toEqual({ state: "public", readAt: READ_AT });
      expect(await reader.answerFor(sealedOne)).toEqual({ state: "sealed", readAt: READ_AT });
      published.add(sealedOne.id);
      expect(await reader.answerFor(sealedOne)).toEqual({ state: "sealed", readAt: READ_AT });

      vi.setSystemTime(Date.now() + 61_000);
      expect(await reader.answerFor(sealedOne)).toEqual({ state: "unsealed", at: UNSEALED_AT, readAt: READ_AT });
      vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000);
      expect(await reader.answerFor(sealedOne)).toEqual({ state: "unsealed", at: UNSEALED_AT, readAt: READ_AT });
      expect(await reader.answerFor(publicOne)).toEqual({ state: "public", readAt: READ_AT });
    } finally {
      vi.useRealTimers();
    }
    // The failed read, the first public read, the first sealed read and the one after the minute.
    expect(reads).toEqual(["ipfs://bafypublic", "ipfs://bafypublic", "ipfs://bafysealed", "ipfs://bafysealed"]);
  });

  // Review pass 6, answers #4 (V46): "sealed" kept for a minute was the stale "still sealed" the
  // service promises never to serve, over a picture its holder had already published.
  it("reads an unseal eleven seconds after sealed was read, and says when each was read", async () => {
    const published = new Set<Hex>();
    const reader = pictureReader({
      readDocument: async () => SEALED_DOCUMENT,
      findRecord: async (id) => (published.has(id) ? recordOf(id) : undefined),
    });
    const passport = { id: `0x${"83".repeat(32)}` as Hex, metadataURI: "ipfs://bafysealed" };

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const start = Date.now();
      expect(await reader.answerFor(passport)).toEqual({ state: "sealed", readAt: Math.floor(start / 1000) });
      published.add(passport.id);
      vi.setSystemTime(start + 11_000);

      expect(await reader.answerFor(passport)).toEqual({
        state: "unsealed",
        at: UNSEALED_AT,
        readAt: Math.floor((start + 11_000) / 1000),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  // Review pass 11, answers #1 (V113): a slow "sealed" read that ended after a newer "unsealed"
  // replaced it, and the sealed plate went back over a picture its holder had published.
  it("keeps a newer unsealed over a slow older sealed read that ends after it", async () => {
    let finishSlow: (found: undefined) => void = () => undefined;
    const lookups: (() => Promise<ReturnType<typeof recordOf> | undefined>)[] = [
      () =>
        new Promise((resolve) => {
          finishSlow = resolve;
        }),
    ];
    const passport = { id: `0x${"84".repeat(32)}` as Hex, metadataURI: "ipfs://bafysealed" };
    const reader = pictureReader({
      readDocument: async () => SEALED_DOCUMENT,
      findRecord: async (id) => await (lookups.shift() ?? (async () => recordOf(id)))(),
    });

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const start = Date.now();
      const slow = reader.answerFor(passport);
      // Lets the slow read reach its record lookup before the newer read starts.
      await new Promise((resolve) => setImmediate(resolve));
      vi.setSystemTime(start + 3_000);
      const unsealed = { state: "unsealed", at: UNSEALED_AT, readAt: Math.floor((start + 3_000) / 1000) };
      expect(await reader.answerFor(passport)).toEqual(unsealed);

      vi.setSystemTime(start + 4_900);
      finishSlow(undefined);
      expect(await slow).toEqual(unsealed);
      expect(await reader.answerFor(passport)).toEqual(unsealed);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the first registration carries the same four facts (pass 4, V18)", () => {
  /** A consent read that says what each passport's holder stated, and records who was asked. */
  function statements(words: Map<Hex, number>, asked: Hex[]): ConsentCall {
    return async (id) => {
      asked.push(id);
      const use = words.get(id);
      if (use === undefined) {
        return [false, { at: 0n, writer: ZERO_ADDRESS, consent: { aiTraining: 0, aiGenerativeTraining: 0, aiInference: 0, dataMining: 0 }, constraintInfo: "" }] as const;
      }
      return [
        true,
        { at: 1_700_000_000n, writer: HOLDER, consent: { aiTraining: use, aiGenerativeTraining: use, aiInference: use, dataMining: use }, constraintInfo: "" },
      ] as const;
    };
  }

  const cleanDispute = disputeReader({
    call: async () => ({ challenger: ZERO_ADDRESS, bond: 0n, evidenceHash: ZERO_HASH, status: 0, openedAt: 0n }),
  });

  it("gives Alice's original her own statement when Mallory's re-compressed copy is the closest match", async () => {
    const alicePicture = await makeImage(94);
    const mallorysCopy = await sharp(alicePicture).jpeg({ quality: 80 }).toBuffer();
    const unchecked = { rechecks: { attestations: 0, matched: 0, mismatched: 0, latest: null } };
    const alice = { ...recordFor(await fingerprint(alicePicture), unchecked), registeredAt: 100, registeredBlock: 10 };
    const mallory = { ...recordFor(await fingerprint(mallorysCopy)), registeredAt: 200, registeredBlock: 20 };
    // Alice said notAllowed on chain (2), Mallory said allowed (1).
    const asked: Hex[] = [];
    const consent = consentReader({ call: statements(new Map([[alice.id, 2], [mallory.id, 1]]), asked) });
    const picture = pictureReader({ readDocument: async () => ({ name: "public" }), findRecord: async () => undefined });
    const app = await buildServer({ source: sourceOf([alice, mallory]), logger: false, consent, dispute: cleanDispute, picture });
    await app.ready();

    try {
      const { payload, headers } = multipartBody("file", "copy.jpg", "image/jpeg", mallorysCopy);
      const response = await app.inject({ method: "POST", url: "/verify", payload, headers });

      expect(response.statusCode).toBe(200);
      const result = response.json().result;
      expect(result.best.id).toBe(mallory.id);
      expect(result.best.consent).toMatchObject({ source: "chain", stated: true, aiTraining: "allowed" });
      expect(result.firstRegisteredId).toBe(alice.id);

      const original = (result.matches as Record<string, unknown>[]).find((match) => match.id === alice.id);
      expect(original).toMatchObject({
        firstRegistered: true,
        consent: { source: "chain", stated: true, aiTraining: "notAllowed" },
        dispute: { source: "chain", status: "none" },
        recheck: { source: "index", attestations: 0 },
        picture: { state: "public" },
      });
      expect([...new Set(asked)].sort()).toEqual([alice.id, mallory.id].sort());
    } finally {
      await app.close();
    }
  }, 60_000);

  it("reads at most three passports: the exact match, the best match and the first registration", async () => {
    const exact = `0x${"a1".repeat(32)}` as Hex;
    const best = `0x${"b2".repeat(32)}` as Hex;
    const first = `0x${"c3".repeat(32)}` as Hex;
    const others = Array.from({ length: 17 }, (_, i) => `0x${(0x10 + i).toString(16).repeat(32)}` as Hex);
    const asked: Hex[] = [];

    const payload = await withPassportFacts(
      {
        result: {
          exact,
          best: { id: best, score: 0.9 },
          matches: [best, exact, ...others, first].map((id) => ({ id, score: 0.5, ...(id === first ? { firstRegistered: true } : {}) })),
          firstRegisteredId: first,
        },
        manifest: { present: false },
      },
      consentReader({ call: statements(new Map([[exact, 1], [best, 1], [first, 2]]), asked) }),
      cleanDispute,
      () => undefined,
      offlinePictureReader(),
    );

    expect(asked.sort()).toEqual([exact, best, first].sort());
    const matches = (payload.result as unknown as { matches: Record<string, unknown>[] }).matches;
    expect(matches.find((match) => match.id === first)?.consent).toMatchObject({ aiTraining: "notAllowed" });
    expect(matches.filter((match) => match.consent !== undefined)).toHaveLength(3);
  });
});
