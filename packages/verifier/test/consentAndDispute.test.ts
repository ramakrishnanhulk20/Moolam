// Covers withConsentAndDispute, the one function both verify routes call to attach the consent
// statement and the dispute status together: the same passport in both the exact and best slot
// costs one read of each rather than two, two different matches read both facts in about one
// timeout rather than two waited through in turn, and the key order a caller sees is unchanged.
// The chain here is a plain stub function, not a fake transport, because the eth_call encoding is
// already covered by consentRead.test.ts and disputeRead.test.ts; this file is about the ordering
// and timing of the reads, not the reads themselves.
// Does NOT cover the enum mapping, the caches, or each reader's own timeout in isolation, which are
// consentRead.test.ts and disputeRead.test.ts, and does not cover a live RPC.

import { describe, expect, it, vi } from "vitest";
import { consentReader, type ConsentCall } from "../src/consentRead.js";
import { disputeReader, withConsentAndDispute, type DisputeCall } from "../src/disputeRead.js";
import { fingerprint } from "../src/fingerprint.js";
import { verifyPaidRoutes } from "../src/routes/verifyPaid.js";
import { buildServer } from "../src/server.js";
import type { PassportSource } from "../src/source/PassportSource.js";
import type { Hex, PassportRecord } from "../src/types.js";
import { makeImage, multipartBody, recordFor } from "./helpers.js";

const HOLDER = "0xC5ead1E4E5C6d56E87e02317f3fB3731cB0b6Ef7" as Hex;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Hex;
const ZERO_HASH = `0x${"00".repeat(32)}` as Hex;

function sourceOf(records: PassportRecord[]): PassportSource {
  return { load: async () => records };
}

describe("withConsentAndDispute", () => {
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

    const payload = await withConsentAndDispute(
      {
        result: { exact: passport, best: { id: passport, score: 1 }, matches: [{ id: passport, score: 1 }] },
        manifest: { present: false },
      },
      consentReader({ call: consentCall }),
      disputeReader({ call: disputeCall }),
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

  it("attaches both facts for two different matches in about one timeout, not two", async () => {
    const timeoutMs = 200;
    const hangingConsent: ConsentCall = () => new Promise(() => undefined);
    const hangingDispute: DisputeCall = () => new Promise(() => undefined);
    const exact = `0x${"11".repeat(32)}` as Hex;
    const other = `0x${"22".repeat(32)}` as Hex;

    const started = Date.now();
    const payload = await withConsentAndDispute(
      {
        result: {
          exact,
          best: { id: other, score: 0.9 },
          matches: [{ id: exact, score: 1 }, { id: other, score: 0.9 }],
        },
        manifest: { present: false },
      },
      consentReader({ call: hangingConsent, timeoutMs }),
      disputeReader({ call: hangingDispute, timeoutMs }),
    );
    const elapsed = Date.now() - started;

    // Both matches hang on both facts: read one after the other this would cost two timeouts
    // (consent for both matches, then dispute for both matches); started together, one covers it.
    expect(elapsed).toBeLessThan(timeoutMs * 1.5);

    const result = payload.result as unknown as { matches: Record<string, unknown>[] };
    for (const match of result.matches) {
      expect(match.consent).toEqual({ source: "unavailable" });
      expect(match.dispute).toEqual({ source: "unavailable" });
    }
  });
});

describe("both facts on the verify routes, read together", () => {
  it("answers /verify in about one timeout when both chain reads hang", async () => {
    const registered = await makeImage(91);
    const record = recordFor(await fingerprint(registered));
    const timeoutMs = 200;
    const consent = consentReader({ call: () => new Promise(() => undefined), timeoutMs });
    const dispute = disputeReader({ call: () => new Promise(() => undefined), timeoutMs });
    const app = await buildServer({ source: sourceOf([record]), logger: false, consent, dispute });
    await app.ready();

    try {
      const { payload, headers } = multipartBody("file", "a.jpg", "image/jpeg", registered);
      const started = Date.now();
      const response = await app.inject({ method: "POST", url: "/verify", payload, headers });
      const elapsed = Date.now() - started;

      expect(response.statusCode).toBe(200);
      expect(elapsed).toBeLessThan(timeoutMs * 1.5);
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
