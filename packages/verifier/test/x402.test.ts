// Covers the paid verify route: the 402 answer and its terms when payment is
// switched on, the 404 when it is off, a real signed payment carried end to end
// over the wire, an older client's X-PAYMENT header, a settlement the
// facilitator has not confirmed yet, what happens when settlement fails after
// the answer is already computed, a repeat of a payment that already bought an
// answer, and the route refusing to serve when it is mounted where x402 is not
// collecting. The facilitator is a stub in every case, so no request leaves the
// machine and no USDC moves.
// Does NOT cover the chain: the stub checks the EIP-3009 signature and the
// authorisation fields the real facilitator checks, but nothing submits
// transferWithAuthorization, so a payer with no USDC, a nonce already spent and
// the facilitator's own gas are out of scope here. Those are what
// `npm run pay:verify` in packages/agents proves against the live facilitator.
// The settlement tests drive the route with a stand-in payment server, so they
// prove our handling and not the x402 library's. The ledger that answers a
// repeat is this process's memory, so a restart or a second instance is out of
// scope too.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { FacilitatorClient, x402HTTPResourceServer } from "@x402/core/server";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { verifyTypedData } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { fingerprint } from "../src/fingerprint.js";
import { parseEnv } from "../src/env.js";
import { buildServer } from "../src/server.js";
import type { PassportSource } from "../src/source/PassportSource.js";
import type { PassportRecord } from "../src/types.js";
import { verifyPaidRoutes } from "../src/routes/verifyPaid.js";
import { buildPaymentServer, X402_NETWORK } from "../src/x402/plugin.js";
import { makeImage, multipartBody, recordFor } from "./helpers.js";

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

/** A verified payment whose settlement is whatever the test hands in. */
function paymentsThatSettleWith(settle: unknown, cancel: unknown): x402HTTPResourceServer {
  return {
    initialize: async () => undefined,
    processHTTPRequest: async () => ({
      type: "payment-verified",
      paymentPayload: {},
      paymentRequirements: {},
      declaredExtensions: [],
      cancellationDispatcher: { cancel },
    }),
    processSettlement: settle,
  } as unknown as x402HTTPResourceServer;
}

/** What the facilitator answers when it has broadcast the transfer but not seen it confirm. */
function pendingSettlement(transaction: string) {
  const pending = {
    success: false,
    errorReason: "settlement_pending",
    errorMessage: "broadcast, not confirmed yet",
    transaction,
    network: X402_NETWORK,
  };
  return {
    ...pending,
    headers: { "PAYMENT-RESPONSE": Buffer.from(JSON.stringify(pending), "utf8").toString("base64") },
    response: { status: 502, headers: {}, body: { error: "settlement pending" } },
  };
}

/** The receipt the caller got back, decoded. */
function receiptOf(header: unknown): { success: boolean; errorReason?: string; transaction: string } {
  return JSON.parse(Buffer.from(String(header), "base64").toString("utf8"));
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

describe("settlement the facilitator has not confirmed yet", () => {
  it("asks once more, then answers with the verification and a pending receipt", async () => {
    const transaction = "0x1d5f2b3c4e5a60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9";
    const cancel = vi.fn(async () => undefined);
    const settle = vi.fn(async () => pendingSettlement(transaction));
    const payments = paymentsThatSettleWith(settle, cancel);

    const image = await makeImage(29);
    const record = recordFor(await fingerprint(image));
    const app = await buildServer({ source: sourceOf([record]), logger: false });
    // The wait between the two settle calls is what makes a second ask worth
    // anything in production and pure delay in a test, so this one is zero.
    await app.register(verifyPaidRoutes, { payments, settlementRetryDelayMs: 0 });
    await app.ready();

    try {
      const { payload, headers } = multipartBody("file", "a.jpg", "image/jpeg", image);
      const response = await app.inject({ method: "POST", url: "/verify/paid", payload, headers });

      expect(response.statusCode).toBe(200);
      expect(settle).toHaveBeenCalledTimes(2);
      expect(cancel).not.toHaveBeenCalled();
      expect((response.json() as { result: { exact: string } }).result.exact).toBe(record.id);

      const receipt = receiptOf(response.headers["payment-response"]);
      expect(receipt.success).toBe(false);
      expect(receipt.errorReason).toBe("settlement_pending");
      expect(receipt.transaction).toBe(transaction);
    } finally {
      await app.close();
    }
  });

  it("answers with the verification and the pending receipt when the second settle call throws", async () => {
    const transaction = "0x2e6a3c4d5f6b70819304b5c6d7e8f9a0b1c2d3e4f5a60718293a4b5c6d7e8f90";
    const cancel = vi.fn(async () => undefined);
    const settle = vi
      .fn()
      .mockResolvedValueOnce(pendingSettlement(transaction))
      .mockRejectedValueOnce(new Error("the facilitator timed out"));

    const image = await makeImage(37);
    const record = recordFor(await fingerprint(image));
    const app = await buildServer({ source: sourceOf([record]), logger: false });
    await app.register(verifyPaidRoutes, { payments: paymentsThatSettleWith(settle, cancel), settlementRetryDelayMs: 0 });
    await app.ready();

    try {
      const { payload, headers } = multipartBody("file", "a.jpg", "image/jpeg", image);
      const response = await app.inject({ method: "POST", url: "/verify/paid", payload, headers });

      expect(response.statusCode).toBe(200);
      expect(settle).toHaveBeenCalledTimes(2);
      expect(cancel).not.toHaveBeenCalled();
      expect((response.json() as { result: { exact: string } }).result.exact).toBe(record.id);
      expect(receiptOf(response.headers["payment-response"]).transaction).toBe(transaction);
    } finally {
      await app.close();
    }
  });

  it("answers with the verification and the first receipt when the second settle call comes back a failure", async () => {
    const transaction = "0x3f7b4d5e6a7c8192a4b5c6d7e8f9a0b1c2d3e4f5a60718293a4b5c6d7e8f9012";
    const cancel = vi.fn(async () => undefined);
    const refused = {
      success: false,
      errorReason: "insufficient_funds",
      errorMessage: "the payer cannot cover it",
      transaction: "",
      network: X402_NETWORK,
      headers: { "PAYMENT-RESPONSE": Buffer.from(JSON.stringify({ success: false }), "utf8").toString("base64") },
      response: { status: 402, headers: {}, body: { error: "payment failed" } },
    };
    const settle = vi.fn().mockResolvedValueOnce(pendingSettlement(transaction)).mockResolvedValueOnce(refused);

    const image = await makeImage(41);
    const record = recordFor(await fingerprint(image));
    const app = await buildServer({ source: sourceOf([record]), logger: false });
    await app.register(verifyPaidRoutes, { payments: paymentsThatSettleWith(settle, cancel), settlementRetryDelayMs: 0 });
    await app.ready();

    try {
      const { payload, headers } = multipartBody("file", "a.jpg", "image/jpeg", image);
      const response = await app.inject({ method: "POST", url: "/verify/paid", payload, headers });

      expect(response.statusCode).toBe(200);
      expect(cancel).not.toHaveBeenCalled();
      expect((response.json() as { result: { exact: string } }).result.exact).toBe(record.id);

      // The transfer the first call broadcast is the one the payer will be
      // charged for, so its receipt is the one that goes out.
      const receipt = receiptOf(response.headers["payment-response"]);
      expect(receipt.errorReason).toBe("settlement_pending");
      expect(receipt.transaction).toBe(transaction);
    } finally {
      await app.close();
    }
  });
});

describe("a payment that already bought an answer", () => {
  it("answers a repeat of the same payment from memory without settling again", async () => {
    const nonce = `0x${"ab".repeat(32)}`;
    const paymentHeader = Buffer.from(
      JSON.stringify({ x402Version: 2, accepted: {}, payload: { authorization: { nonce } } }),
      "utf8",
    ).toString("base64");
    const cancel = vi.fn(async () => undefined);
    const settle = vi.fn(async () => ({
      success: true,
      transaction: "0x4a8c5e6f7b8d92a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b",
      network: X402_NETWORK,
      headers: { "PAYMENT-RESPONSE": Buffer.from(JSON.stringify({ success: true }), "utf8").toString("base64") },
      requirements: {},
    }));
    const payments = paymentsThatSettleWith(settle, cancel);
    const processed = vi.spyOn(payments, "processHTTPRequest");

    const image = await makeImage(43);
    const record = recordFor(await fingerprint(image));
    const app = await buildServer({ source: sourceOf([record]), logger: false });
    await app.register(verifyPaidRoutes, { payments, settlementRetryDelayMs: 0 });
    await app.ready();

    try {
      const send = async () => {
        const { payload, headers } = multipartBody("file", "a.jpg", "image/jpeg", image);
        return await app.inject({
          method: "POST",
          url: "/verify/paid",
          payload,
          headers: { ...headers, "payment-signature": paymentHeader },
        });
      };

      const first = await send();
      const second = await send();

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(second.json()).toEqual(first.json());
      expect(second.headers["payment-response"]).toBe(first.headers["payment-response"]);
      expect(settle).toHaveBeenCalledTimes(1);
      expect(processed).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});

describe("a route x402 is not collecting on", () => {
  it("refuses to mount anywhere but /verify/paid", async () => {
    const app = await buildServer({ source: sourceOf([]), logger: false });
    app.register(verifyPaidRoutes, {
      payments: paymentsThatSettleWith(vi.fn(), vi.fn()),
      prefix: "/paid",
    });

    try {
      await expect(app.ready()).rejects.toThrow(/must be mounted at \/verify\/paid/);
    } finally {
      await app.close();
    }
  });

  it("answers 500 and serves nothing when x402 says no payment is required", async () => {
    const settle = vi.fn();
    const payments = {
      initialize: async () => undefined,
      processHTTPRequest: async () => ({ type: "no-payment-required" }),
      processSettlement: settle,
    } as unknown as x402HTTPResourceServer;

    const image = await makeImage(47);
    const record = recordFor(await fingerprint(image));
    const app = await buildServer({ source: sourceOf([record]), logger: false });
    await app.register(verifyPaidRoutes, { payments });
    await app.ready();

    try {
      const { payload, headers } = multipartBody("file", "a.jpg", "image/jpeg", image);
      const response = await app.inject({ method: "POST", url: "/verify/paid", payload, headers });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: "payment-misconfigured" });
      expect(response.body).not.toContain(record.id);
      expect(settle).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe("a signed payment", () => {
  it("carries a real EIP-3009 authorisation the facilitator can check, and comes back settled", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const seen: { payload?: PaymentPayload; requirements?: PaymentRequirements } = {};
    const transaction = "0xabc1230000000000000000000000000000000000000000000000000000000def";

    const facilitator: FacilitatorClient = {
      async getSupported() {
        return {
          kinds: [{ x402Version: 2, scheme: "exact", network: X402_NETWORK }],
          extensions: [],
          signers: {},
        };
      },
      async verify(payload, requirements) {
        seen.payload = payload as PaymentPayload;
        seen.requirements = requirements as PaymentRequirements;
        return { isValid: true, payer: account.address };
      },
      async settle() {
        return { success: true, transaction, network: X402_NETWORK, payer: account.address };
      },
    };

    const image = await makeImage(31);
    const record = recordFor(await fingerprint(image));
    const app = await buildServer({
      source: sourceOf([record]),
      logger: false,
      payments: buildPaymentServer({ payTo: PAY_TO, price: "$0.05", facilitator }),
    });
    await app.ready();

    try {
      const unpaid = await app.inject({ method: "POST", url: "/verify/paid" });
      expect(unpaid.statusCode).toBe(402);

      const client = new x402Client().register(X402_NETWORK, new ExactEvmScheme(account));
      const http = new x402HTTPClient(client);
      const terms = http.getPaymentRequiredResponse((name) => unpaid.headers[name.toLowerCase()] as string | undefined);
      const signed = await http.createPaymentPayload(terms);

      const { payload, headers } = multipartBody("file", "a.jpg", "image/jpeg", image);
      const response = await app.inject({
        method: "POST",
        url: "/verify/paid",
        payload,
        headers: { ...headers, ...http.encodePaymentSignatureHeader(signed) },
      });

      expect(response.statusCode).toBe(200);
      expect((response.json() as { result: { exact: string } }).result.exact).toBe(record.id);

      const authorization = seen.payload?.payload.authorization as {
        from: string;
        to: string;
        value: string;
        validAfter: string;
        validBefore: string;
        nonce: `0x${string}`;
      };
      expect(authorization.from).toBe(account.address);
      expect(authorization.to).toBe(PAY_TO);
      expect(authorization.value).toBe("50000");
      expect(Number(authorization.validBefore)).toBeGreaterThan(Math.floor(Date.now() / 1000));
      expect(authorization.nonce).toMatch(/^0x[0-9a-f]{64}$/);

      // The point of the test: the bytes on the wire are a transferWithAuthorization
      // this account really signed, against Monad mainnet USDC, for this amount.
      const signature = seen.payload?.payload.signature as `0x${string}`;
      const valid = await verifyTypedData({
        address: account.address,
        domain: {
          name: "USDC",
          version: "2",
          chainId: 143,
          verifyingContract: seen.requirements?.asset as `0x${string}`,
        },
        types: {
          TransferWithAuthorization: [
            { name: "from", type: "address" },
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
            { name: "validAfter", type: "uint256" },
            { name: "validBefore", type: "uint256" },
            { name: "nonce", type: "bytes32" },
          ],
        },
        primaryType: "TransferWithAuthorization",
        message: {
          from: account.address,
          to: authorization.to as `0x${string}`,
          value: BigInt(authorization.value),
          validAfter: BigInt(authorization.validAfter),
          validBefore: BigInt(authorization.validBefore),
          nonce: authorization.nonce,
        },
        signature,
      });
      expect(valid).toBe(true);

      const receipt = http.getPaymentSettleResponse(
        (name) => response.headers[name.toLowerCase()] as string | undefined,
      );
      expect(receipt.success).toBe(true);
      expect(receipt.transaction).toBe(transaction);
    } finally {
      await app.close();
    }
  });

  it("reads an older client's X-PAYMENT header as a payment", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const verified = vi.fn(async () => ({ isValid: true, payer: account.address }));
    const facilitator: FacilitatorClient = {
      async getSupported() {
        return {
          kinds: [{ x402Version: 2, scheme: "exact", network: X402_NETWORK }],
          extensions: [],
          signers: {},
        };
      },
      verify: verified,
      async settle() {
        return {
          success: true,
          transaction: "0x5b9d6f7a8c9e03b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8",
          network: X402_NETWORK,
          payer: account.address,
        };
      },
    };

    const image = await makeImage(53);
    const record = recordFor(await fingerprint(image));
    const app = await buildServer({
      source: sourceOf([record]),
      logger: false,
      payments: buildPaymentServer({ payTo: PAY_TO, price: "$0.05", facilitator }),
    });
    await app.ready();

    try {
      const unpaid = await app.inject({ method: "POST", url: "/verify/paid" });
      const client = new x402Client().register(X402_NETWORK, new ExactEvmScheme(account));
      const http = new x402HTTPClient(client);
      const terms = http.getPaymentRequiredResponse((name) => unpaid.headers[name.toLowerCase()] as string | undefined);
      const signed = await http.createPaymentPayload(terms);
      const v2 = http.encodePaymentSignatureHeader(signed);
      const value = Object.values(v2)[0] as string;

      const { payload, headers } = multipartBody("file", "a.jpg", "image/jpeg", image);
      const response = await app.inject({
        method: "POST",
        url: "/verify/paid",
        payload,
        headers: { ...headers, "x-payment": value },
      });

      expect(response.statusCode).toBe(200);
      expect(verified).toHaveBeenCalledTimes(1);
      expect((response.json() as { result: { exact: string } }).result.exact).toBe(record.id);
    } finally {
      await app.close();
    }
  });
});

describe("settlement failure", () => {
  it("cancels the authorisation and answers 502 when the facilitator throws while settling", async () => {
    const cancel = vi.fn(async () => undefined);
    const payments = {
      initialize: async () => undefined,
      processHTTPRequest: async () => ({
        type: "payment-verified",
        paymentPayload: {},
        paymentRequirements: {},
        declaredExtensions: [],
        cancellationDispatcher: { cancel },
      }),
      processSettlement: async () => {
        throw new Error("facilitator refused the settle call");
      },
    } as unknown as x402HTTPResourceServer;

    const image = await makeImage(23);
    const app = await buildServer({
      source: sourceOf([recordFor(await fingerprint(image))]),
      logger: false,
      payments,
    });
    await app.ready();

    try {
      const { payload, headers } = multipartBody("file", "a.jpg", "image/jpeg", image);
      const response = await app.inject({ method: "POST", url: "/verify/paid", payload, headers });

      expect(response.statusCode).toBe(502);
      expect(response.json().error).toMatch(/could not be settled: facilitator refused the settle call/);
      expect(cancel).toHaveBeenCalledWith({ reason: "handler_failed", responseStatus: 502 });
    } finally {
      await app.close();
    }
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
