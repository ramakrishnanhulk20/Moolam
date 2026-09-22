// Covers withPassportFacts, the one function both verify routes call to attach the consent
// statement and the dispute status together: the same passport in both the exact and best slot
// costs one read of each rather than two, every read for two different matches has started before
// the first one gives up (so a dead chain costs one timeout, not several in turn), and the key
// order a caller sees is unchanged. The "started together" tests look at the order of events and
// never at a clock: an earlier version timed the call against 1.5 timeouts and failed whenever the
// machine was busy, which measured the machine and not the code.
// The chain here is a plain stub function, not a fake transport, because the eth_call encoding is
// already covered by consentRead.test.ts and disputeRead.test.ts; this file is about the ordering
// of the reads, not the reads themselves.
// Does NOT cover the enum mapping, the caches, or each reader's own timeout in isolation, which are
// consentRead.test.ts and disputeRead.test.ts, and does not cover a live RPC.

import { describe, expect, it, vi } from "vitest";
import { consentReader, type ConsentCall } from "../src/consentRead.js";
import { disputeReader, withPassportFacts, type DisputeCall } from "../src/disputeRead.js";
import { fingerprint } from "../src/fingerprint.js";
import { verifyPaidRoutes } from "../src/routes/verifyPaid.js";
import { buildServer } from "../src/server.js";
import type { PassportSource } from "../src/source/PassportSource.js";
import type { Hex, PassportRecord } from "../src/types.js";
import { makeImage, multipartBody, recordFor } from "./helpers.js";

const HOLDER = "0xC5ead1E4E5C6d56E87e02317f3fB3731cB0b6Ef7" as Hex;
const RECHECKER = "0x0d69055c43eacb3b1ca687ca2263a049bc7eff04" as Hex;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Hex;
const ZERO_HASH = `0x${"00".repeat(32)}` as Hex;

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
    );

    expect(consentAsked).toEqual([passport]);
    expect(disputeAsked).toEqual([passport]);

    const best = (payload.result as unknown as { best: Record<string, unknown> }).best;
    expect(best.consent).toMatchObject({ source: "chain", stated: true });
    expect(best.dispute).toEqual({ source: "chain", status: "none" });
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
    );

    for (const [what, payload] of [["unreadable", unreadable], ["broken", broken]] as const) {
      const best = (payload.result as unknown as { best: Record<string, unknown> }).best;
      expect(best.dispute, what).toEqual({ source: "unavailable" });
      expect(best.consent, what).toMatchObject({ source: "chain", stated: true, aiTraining: "notAllowed" });
      expect(best.recheck, what).toMatchObject({ source: "index", attestations: 1, matched: 1 });
      expect(Object.keys(best), what).toEqual(["id", "score", "consent", "dispute", "recheck"]);
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
