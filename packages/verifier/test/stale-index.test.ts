// Covers review pass 9 V82: a refresh of the passport index that keeps failing used to leave every
// verify answering from an old copy with nothing saying so. /health and every verify answer, free
// and paid, now carry index { loadedAt, stale }: loadedAt is the unix second of the last good load,
// and stale turns on once that copy is older than five refresh periods and off after the next good
// load. The clock and the refresh period are handed in, and the refreshes are called by the test.
// Does NOT cover the refresh timer firing on its own (a setInterval around the same reload), a real
// Envio source, or the facilitator: the paid route's payment server is a stub that settles.

import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { HTTPRequestContext, x402HTTPResourceServer } from "@x402/core/server";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fingerprint } from "../src/fingerprint.js";
import { verifyPaidRoutes } from "../src/routes/verifyPaid.js";
import { buildServer } from "../src/server.js";
import type { PassportSource } from "../src/source/PassportSource.js";
import type { PassportRecord } from "../src/types.js";
import { makeImage, multipartBody, recordFor } from "./helpers.js";

const PERIOD_MS = 60_000;
const BOOT = Date.parse("2026-09-26T12:00:00Z");

/** A payment server whose facilitator verifies and settles every payment. */
function settlingPayments(): x402HTTPResourceServer {
  return {
    initialize: async () => undefined,
    processHTTPRequest: async (context: HTTPRequestContext) => ({
      type: "payment-verified",
      paymentPayload: decodePaymentSignatureHeader(context.adapter.getHeader("payment-signature") ?? ""),
      paymentRequirements: {},
      declaredExtensions: [],
      cancellationDispatcher: { cancel: async () => undefined },
    }),
    processSettlement: async () => ({ success: true, headers: {}, transaction: `0x${"7a".repeat(32)}` }),
  } as unknown as x402HTTPResourceServer;
}

/** A payment header with a fresh nonce, so each paid request is a payment of its own. */
function paymentHeader(nonceByte: number): string {
  const nonce = `0x${nonceByte.toString(16).padStart(2, "0").repeat(32)}`;
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      accepted: {},
      payload: {
        signature: `0x${"5a".repeat(65)}`,
        authorization: {
          from: "0x3333333333333333333333333333333333333333",
          to: "0xC5ead1E4E5C6d56E87e02317f3fB3731cB0b6Ef7",
          value: "50000",
          validAfter: "0",
          validBefore: "1790051150",
          nonce,
        },
      },
    }),
    "utf8",
  ).toString("base64");
}

describe("V82: a copy of the register that has fallen behind says so", () => {
  let app: FastifyInstance;
  let now = BOOT;
  let failing = false;
  let picture: Buffer;
  let held: PassportRecord[];
  let nonces = 0;

  const source: PassportSource = {
    load: async () => {
      if (failing) {
        throw new Error("the indexer answered 429");
      }
      return [...held];
    },
  };

  beforeAll(async () => {
    picture = await makeImage(141);
    held = [recordFor(await fingerprint(picture))];
    app = await buildServer({ source, logger: false, index: { refreshMs: PERIOD_MS, clock: () => now } });
    await app.register(verifyPaidRoutes, { payments: settlingPayments(), settlementRetryDelayMs: 0 });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  /** What /health, /verify and /verify/paid each say about the index right now. */
  async function indexSaid(): Promise<unknown[]> {
    const health = await app.inject({ method: "GET", url: "/health" });
    const free = multipartBody("file", "a.jpg", "image/jpeg", picture);
    const verify = await app.inject({ method: "POST", url: "/verify", payload: free.payload, headers: free.headers });
    const paidBody = multipartBody("file", "a.jpg", "image/jpeg", picture);
    nonces += 1;
    const paid = await app.inject({
      method: "POST",
      url: "/verify/paid",
      payload: paidBody.payload,
      headers: { ...paidBody.headers, "payment-signature": paymentHeader(nonces) },
    });
    expect([health.statusCode, verify.statusCode, paid.statusCode]).toEqual([200, 200, 200]);
    return [health.json().index, verify.json().index, paid.json().index];
  }

  it("turns stale on after five refresh periods of failed refreshes, and off after the next good load", async () => {
    const booted = { loadedAt: BOOT / 1000, stale: false };
    expect(await indexSaid()).toEqual([booted, booted, booted]);

    failing = true;
    for (let period = 1; period <= 5; period += 1) {
      now = BOOT + period * PERIOD_MS;
      await app.verifier.reload();
    }
    // Five periods old exactly is still inside the promise.
    expect(await indexSaid()).toEqual([booted, booted, booted]);

    now = BOOT + 5 * PERIOD_MS + 1_000;
    await app.verifier.reload();
    const stale = { loadedAt: BOOT / 1000, stale: true };
    expect(await indexSaid()).toEqual([stale, stale, stale]);

    failing = false;
    now = BOOT + 6 * PERIOD_MS;
    await app.verifier.reload();
    const fresh = { loadedAt: now / 1000, stale: false };
    expect(await indexSaid()).toEqual([fresh, fresh, fresh]);
  }, 60_000);
});
