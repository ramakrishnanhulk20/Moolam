// Covers the paid verify route: the 402 answer and its terms when payment is
// switched on, and the 404 when it is off. The facilitator is a stub, so no
// request leaves the machine and no USDC moves.
// Does NOT cover a real payment: verifying a signature, settling it, and the
// PAYMENT-RESPONSE header are the facilitator's job and need a funded client
// wallet, which this suite does not have.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { FacilitatorClient } from "@x402/core/server";
import { fingerprint } from "../src/fingerprint.js";
import { parseEnv } from "../src/env.js";
import { buildServer } from "../src/server.js";
import type { PassportSource } from "../src/source/PassportSource.js";
import type { PassportRecord } from "../src/types.js";
import { buildPaymentServer, X402_NETWORK } from "../src/x402/plugin.js";
import { makeImage, recordFor } from "./helpers.js";

const PAY_TO = "0xC5ead1E4E5C6d56E87e02317f3fB3731cB0b6Ef7";

/** Answers the one call the resource server makes at startup, and nothing else. */
function stubFacilitator(): FacilitatorClient {
  return {
    async getSupported() {
      return {
        kinds: [{ x402Version: 2, scheme: "exact", network: X402_NETWORK }],
        extensions: [],
        signers: {},
      };
    },
    async verify() {
      throw new Error("the stub facilitator must never be asked to verify");
    },
    async settle() {
      throw new Error("the stub facilitator must never be asked to settle");
    },
  };
}

function sourceOf(records: PassportRecord[]): PassportSource {
  return { load: async () => records };
}

describe("paid verify route", () => {
  let paid: FastifyInstance;
  let free: FastifyInstance;

  beforeAll(async () => {
    const record = recordFor(await fingerprint(await makeImage(17)));
    paid = await buildServer({
      source: sourceOf([record]),
      logger: false,
      payments: buildPaymentServer({ payTo: PAY_TO, price: "$0.05", facilitator: stubFacilitator() }),
    });
    free = await buildServer({ source: sourceOf([record]), logger: false });
    await Promise.all([paid.ready(), free.ready()]);
  });

  afterAll(async () => {
    await Promise.all([paid.close(), free.close()]);
  });

  it("asks for payment, in USDC on Monad, when no payment header is sent", async () => {
    const response = await paid.inject({ method: "POST", url: "/verify/paid" });

    expect(response.statusCode).toBe(402);
    expect(response.json()).toMatchObject({ error: "payment required" });

    const header = response.headers["payment-required"];
    expect(typeof header).toBe("string");
    const terms = JSON.parse(Buffer.from(String(header), "base64").toString("utf8")) as {
      x402Version: number;
      accepts: { scheme: string; network: string; payTo: string; asset: string; amount: string }[];
    };
    expect(terms.x402Version).toBe(2);
    expect(terms.accepts).toHaveLength(1);
    expect(terms.accepts[0]?.scheme).toBe("exact");
    expect(terms.accepts[0]?.network).toBe(X402_NETWORK);
    expect(terms.accepts[0]?.payTo).toBe(PAY_TO);
    expect(terms.accepts[0]?.asset.toLowerCase()).toBe("0x754704bc059f8c67012fed69bc8a327a5aafb603");
    expect(terms.accepts[0]?.amount).toBe("50000");
  });

  it("does not exist at all when payment is switched off", async () => {
    const response = await free.inject({ method: "POST", url: "/verify/paid" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "no route for POST /verify/paid" });
  });

  it("still answers the free route while the paid one is mounted", async () => {
    const health = await paid.inject({ method: "GET", url: "/health" });

    expect(health.statusCode).toBe(200);
    expect((health.json() as { records: number }).records).toBe(1);
  });
});

describe("payment environment", () => {
  it("is off by default and needs nothing set", () => {
    const parsed = parseEnv({});
    expect(parsed.X402_ENABLED).toBe(false);
    expect(parsed.X402_PRICE).toBe("$0.05");
    expect(parsed.X402_FACILITATOR_URL).toBe("https://x402-facilitator.molandak.org");
  });

  it("refuses to switch payment on without an address to pay", () => {
    expect(() => parseEnv({ X402_ENABLED: "true" })).toThrow(/X402_PAY_TO_ADDRESS/);
    expect(parseEnv({ X402_ENABLED: "true", X402_PAY_TO_ADDRESS: PAY_TO }).X402_ENABLED).toBe(true);
  });

  it("names the variable when a key, an address or a price is malformed", () => {
    expect(() => parseEnv({ X402_ENABLED: "yes" })).toThrow(/X402_ENABLED/);
    expect(() => parseEnv({ X402_ENABLED: "true", X402_PAY_TO_ADDRESS: "0x1234" })).toThrow(/X402_PAY_TO_ADDRESS/);
    expect(() => parseEnv({ X402_ENABLED: "true", X402_PAY_TO_ADDRESS: PAY_TO, X402_PRICE: "5 dollars" })).toThrow(
      /X402_PRICE/,
    );
    expect(() => parseEnv({ VERIFIER_PRIVATE_KEY: "0xabc" })).toThrow(/VERIFIER_PRIVATE_KEY/);
    expect(() => parseEnv({ VERIFIER_ADDRESS: "not-an-address" })).toThrow(/VERIFIER_ADDRESS/);
    expect(() => parseEnv({ MONAD_MAINNET_RPC_URL: "rpc.monad.xyz" })).toThrow(/MONAD_MAINNET_RPC_URL/);
  });
});
