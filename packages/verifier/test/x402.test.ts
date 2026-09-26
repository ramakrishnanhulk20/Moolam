// Covers the paid verify route: the 402 answer and its terms when payment is
// switched on, the 404 when it is off, a real signed payment carried end to end
// over the wire, an older client's X-PAYMENT header, a settlement the
// facilitator has not confirmed yet, what happens when settlement fails after
// the answer is already computed, a repeat of a payment that already bought an
// answer, and the route refusing to serve when it is mounted where x402 is not
// collecting. The facilitator is a stub in every case, so no request leaves the
// machine and no USDC moves.
// From the verifier review: a remembered answer goes only to a request carrying
// the very payment that bought it and the same file (V7), and a settlement whose
// outcome is unknown is asked again, then read from the chain, and reported as
// unknown rather than refused, so a payer who was charged is never served nothing
// (V15). The chain read is a stub here. An answer held that way is never let go on a "not spent"
// read, which a first transfer still pending also gives, and a retry whose first settle is refused
// serves it once the chain shows the first transfer (pass 4, V21; pass 5, answers #6). The chain
// check proves a payment only by a transaction the facilitator named for it, read against fake
// receipts, never by authorizationState alone (pass 5, answers #4).
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
import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { FacilitatorClient, HTTPRequestContext, x402HTTPResourceServer } from "@x402/core/server";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { encodeAbiParameters, encodeEventTopics, parseAbi, verifyTypedData, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { fingerprint } from "../src/fingerprint.js";
import { parseEnv } from "../src/env.js";
import { buildServer } from "../src/server.js";
import type { PassportSource } from "../src/source/PassportSource.js";
import type { PassportRecord } from "../src/types.js";
import { chainCharged, verifyPaidRoutes } from "../src/routes/verifyPaid.js";

const USDC_EVENTS = parseAbi([
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
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

/**
 * A payment server whose settlement is whatever the test hands in. A header that decodes to a
 * payload with a signature is verified, as the facilitator would verify a real one, and anything
 * else is asked to pay.
 */
function paymentsThatSettleWith(settle: unknown, cancel: unknown): x402HTTPResourceServer {
  return {
    initialize: async () => undefined,
    processHTTPRequest: async (context: HTTPRequestContext) => {
      const header = context.adapter.getHeader("payment-signature");
      let payload: Record<string, unknown> = {};
      if (header !== undefined) {
        payload = decodePaymentSignatureHeader(header) as unknown as Record<string, unknown>;
        const signature = (payload.payload as { signature?: unknown } | undefined)?.signature;
        if (typeof signature !== "string") {
          return { type: "payment-error", response: { status: 402, headers: {}, body: { error: "payment required" } } };
        }
      }
      return {
        type: "payment-verified",
        paymentPayload: payload,
        paymentRequirements: { asset: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603" },
        declaredExtensions: [],
        cancellationDispatcher: { cancel },
      };
    },
    processSettlement: settle,
  } as unknown as x402HTTPResourceServer;
}

/** A payment header as a client sends it: one signed EIP-3009 authorisation. */
function paymentHeaderFor(nonce: string, signature = `0x${"5a".repeat(65)}`): string {
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      accepted: {},
      payload: {
        signature,
        authorization: {
          from: "0x3333333333333333333333333333333333333333",
          to: PAY_TO,
          value: "50000",
          validAfter: "0",
          validBefore: "4102444800",
          nonce,
        },
      },
    }),
    "utf8",
  ).toString("base64");
}

/** What processSettlement hands back once the facilitator has settled. */
function settled(transaction: string) {
  return {
    success: true,
    transaction,
    network: X402_NETWORK,
    headers: { "PAYMENT-RESPONSE": Buffer.from(JSON.stringify({ success: true, transaction }), "utf8").toString("base64") },
    requirements: {},
  };
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
    const paymentHeader = paymentHeaderFor(nonce);
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

  // V7: the nonce is public on chain once the transfer settles, so it can never be the key alone.
  it("hands nothing to a request carrying only the payer's public nonce, or the payment with another file", async () => {
    const nonce = `0x${"cd".repeat(32)}`;
    const cancel = vi.fn(async () => undefined);
    const settle = vi.fn(async () => settled(`0x${"4b".repeat(32)}`));
    const payments = paymentsThatSettleWith(settle, cancel);
    const processed = vi.spyOn(payments, "processHTTPRequest");

    const image = await makeImage(44);
    const other = await makeImage(45);
    const record = recordFor(await fingerprint(image));
    const app = await buildServer({ source: sourceOf([record]), logger: false });
    await app.register(verifyPaidRoutes, { payments, settlementRetryDelayMs: 0 });
    await app.ready();

    try {
      const { payload, headers } = multipartBody("file", "a.jpg", "image/jpeg", image);
      const bought = await app.inject({
        method: "POST",
        url: "/verify/paid",
        payload,
        headers: { ...headers, "payment-signature": paymentHeaderFor(nonce) },
      });
      expect(bought.statusCode).toBe(200);

      const nonceOnly = Buffer.from(JSON.stringify({ payload: { authorization: { nonce } } }), "utf8").toString("base64");
      const forged = await app.inject({ method: "POST", url: "/verify/paid", headers: { "payment-signature": nonceOnly } });
      expect(forged.statusCode).toBe(402);
      expect(forged.body).not.toContain(record.id);

      const second = multipartBody("file", "b.jpg", "image/jpeg", other);
      const otherFile = await app.inject({
        method: "POST",
        url: "/verify/paid",
        payload: second.payload,
        headers: { ...second.headers, "payment-signature": paymentHeaderFor(nonce) },
      });
      expect(otherFile.body).not.toContain(record.id);
      expect(processed).toHaveBeenCalledTimes(3);
    } finally {
      await app.close();
    }
  });
});

describe("a settlement whose outcome is unknown (V15)", () => {
  async function paidApp(settle: unknown, charged: () => Promise<boolean | undefined>) {
    const cancel = vi.fn(async () => undefined);
    const image = await makeImage(61);
    const record = recordFor(await fingerprint(image));
    const app = await buildServer({ source: sourceOf([record]), logger: false });
    await app.register(verifyPaidRoutes, {
      payments: paymentsThatSettleWith(settle, cancel),
      settlementRetryDelayMs: 0,
      charged,
    });
    await app.ready();
    const send = async (header: string) => {
      const { payload, headers } = multipartBody("file", "a.jpg", "image/jpeg", image);
      return await app.inject({ method: "POST", url: "/verify/paid", payload, headers: { ...headers, "payment-signature": header } });
    };
    return { app, cancel, record, send };
  }

  it("asks again when the first settle call threw, and serves the answer when the second settles", async () => {
    const settle = vi
      .fn()
      .mockRejectedValueOnce(new Error("the facilitator timed out"))
      .mockResolvedValueOnce(settled(`0x${"6c".repeat(32)}`));
    const { app, cancel, record, send } = await paidApp(settle, async () => false);

    try {
      const response = await send(paymentHeaderFor(`0x${"e1".repeat(32)}`));
      expect(response.statusCode).toBe(200);
      expect(response.json().result.exact).toBe(record.id);
      expect(settle).toHaveBeenCalledTimes(2);
      expect(cancel).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("reads a failure in words, not a facilitator's reason code, as unknown and asks again", async () => {
    const lost = {
      success: false,
      errorReason: "fetch failed",
      errorMessage: "fetch failed",
      transaction: "",
      network: X402_NETWORK,
      headers: {},
      response: { status: 402, headers: {}, body: { error: "fetch failed" } },
    };
    const settle = vi.fn().mockResolvedValueOnce(lost).mockResolvedValueOnce(settled(`0x${"6d".repeat(32)}`));
    const { app, send } = await paidApp(settle, async () => false);

    try {
      expect((await send(paymentHeaderFor(`0x${"e2".repeat(32)}`))).statusCode).toBe(200);
      expect(settle).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it("serves the answer when the chain shows the payment was spent, whatever the facilitator said", async () => {
    const settle = vi.fn().mockRejectedValue(new Error("socket hang up"));
    const { app, cancel, record, send } = await paidApp(settle, async () => true);

    try {
      const response = await send(paymentHeaderFor(`0x${"e3".repeat(32)}`));
      expect(response.statusCode).toBe(200);
      expect(response.json().result.exact).toBe(record.id);
      expect(cancel).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("says unknown rather than refused when nobody can tell, and the same payment is served once the chain shows it spent", async () => {
    const settle = vi.fn().mockRejectedValue(new Error("socket hang up"));
    let spent: boolean | undefined;
    const { app, cancel, record, send } = await paidApp(settle, async () => spent);
    const header = paymentHeaderFor(`0x${"e4".repeat(32)}`);

    try {
      const unknown = await send(header);
      expect(unknown.statusCode).toBe(502);
      expect(unknown.json().error).toBe("settlement-unknown");
      expect(unknown.body).not.toContain(record.id);
      expect(cancel).not.toHaveBeenCalled();
      expect(settle).toHaveBeenCalledTimes(2);

      spent = true;
      const later = await send(header);
      expect(later.statusCode).toBe(200);
      expect(later.json().result.exact).toBe(record.id);
      expect(settle).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it("refuses at once, without asking again, when the facilitator names a reason", async () => {
    const refused = {
      success: false,
      errorReason: "insufficient_funds",
      errorMessage: "the payer cannot cover it",
      transaction: "",
      network: X402_NETWORK,
      headers: {},
      response: { status: 402, headers: {}, body: { error: "payment failed" } },
    };
    const settle = vi.fn().mockResolvedValue(refused);
    const { app, cancel, record, send } = await paidApp(settle, async () => false);

    try {
      const response = await send(paymentHeaderFor(`0x${"e5".repeat(32)}`));
      expect(response.statusCode).toBe(402);
      expect(response.body).not.toContain(record.id);
      expect(settle).toHaveBeenCalledTimes(1);
      expect(cancel).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe("an answer held as settlement-unknown (pass 4, V21)", () => {
  /**
   * A facilitator that refuses a nonce it has already verified once, as the reference x402
   * facilitator answers a used EIP-3009 nonce, so a request the ledger lets through goes nowhere.
   */
  async function onceOnlyApp(charged: () => Promise<boolean | undefined>) {
    const settle = vi.fn().mockRejectedValue(new Error("socket hang up"));
    const inner = paymentsThatSettleWith(settle, vi.fn(async () => undefined));
    const used = new Set<string>();
    const payments = {
      ...inner,
      processHTTPRequest: async (context: HTTPRequestContext) => {
        const header = context.adapter.getHeader("payment-signature") ?? "";
        if (used.has(header)) {
          return {
            type: "payment-error",
            response: { status: 402, headers: {}, body: { error: "invalid_exact_evm_nonce_already_used" } },
          };
        }
        used.add(header);
        return await inner.processHTTPRequest(context);
      },
    } as unknown as x402HTTPResourceServer;

    const image = await makeImage(62);
    const other = await makeImage(63);
    const record = recordFor(await fingerprint(image));
    const app = await buildServer({ source: sourceOf([record]), logger: false });
    await app.register(verifyPaidRoutes, { payments, settlementRetryDelayMs: 0, charged });
    await app.ready();
    const send = async (header: string, file = image) => {
      const { payload, headers } = multipartBody("file", "a.jpg", "image/jpeg", file);
      return await app.inject({ method: "POST", url: "/verify/paid", payload, headers: { ...headers, "payment-signature": header } });
    };
    return { app, record, other, send };
  }

  it("keeps the held answer through a retry while the chain read fails, and serves it once the chain answers", async () => {
    let spent: boolean | undefined;
    const { app, record, send } = await onceOnlyApp(async () => spent);
    const header = paymentHeaderFor(`0x${"f1".repeat(32)}`);

    try {
      expect((await send(header)).json().error).toBe("settlement-unknown");
      // The chain read fails on the retry, so nobody can say the payment was not spent.
      expect((await send(header)).statusCode).not.toBe(200);

      spent = true;
      const later = await send(header);
      expect(later.statusCode).toBe(200);
      expect(later.json().result.exact).toBe(record.id);
    } finally {
      await app.close();
    }
  });

  it("keeps the held answer when the same payment arrives with another file", async () => {
    let spent: boolean | undefined;
    const { app, record, other, send } = await onceOnlyApp(async () => spent);
    const header = paymentHeaderFor(`0x${"f2".repeat(32)}`);

    try {
      expect((await send(header)).json().error).toBe("settlement-unknown");
      spent = true;
      const wrongFile = await send(header, other);
      expect(wrongFile.statusCode).not.toBe(200);
      expect(wrongFile.body).not.toContain(record.id);

      const later = await send(header);
      expect(later.statusCode).toBe(200);
      expect(later.json().result.exact).toBe(record.id);
    } finally {
      await app.close();
    }
  });

  // Review pass 5, answers #6: "not spent" can be read while the first transfer is still pending.
  it("keeps the held answer through a not-spent read, and serves it once the first transfer lands", async () => {
    let spent: boolean | undefined = false;
    const { app, record, send } = await onceOnlyApp(async () => spent);
    const header = paymentHeaderFor(`0x${"f3".repeat(32)}`);

    try {
      expect((await send(header)).json().error).toBe("settlement-unknown");
      // Not spent yet: the payment goes to the facilitator as new, and the held answer stays.
      expect((await send(header)).json()).toEqual({ error: "invalid_exact_evm_nonce_already_used" });
      spent = true;
      const later = await send(header);
      expect(later.statusCode).toBe(200);
      expect(later.json().result.exact).toBe(record.id);
    } finally {
      await app.close();
    }
  });

  it("serves the held answer when the retry's first settle is refused because the first transfer landed meanwhile", async () => {
    const nonceUsed = {
      success: false,
      errorReason: "invalid_exact_evm_nonce_already_used",
      errorMessage: "nonce used",
      transaction: "",
      network: X402_NETWORK,
      headers: {},
      response: { status: 402, headers: {}, body: { error: "invalid_exact_evm_nonce_already_used" } },
    };
    const settle = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValue(nonceUsed);
    let spent: boolean | undefined;
    const reads: (boolean | undefined)[] = [undefined, undefined, false, true];
    const charged = vi.fn(async () => (reads.length > 0 ? reads.shift() : spent));
    const image = await makeImage(64);
    const record = recordFor(await fingerprint(image));
    const app = await buildServer({ source: sourceOf([record]), logger: false });
    await app.register(verifyPaidRoutes, {
      payments: paymentsThatSettleWith(settle, vi.fn(async () => undefined)),
      settlementRetryDelayMs: 0,
      charged,
    });
    await app.ready();
    const header = paymentHeaderFor(`0x${"f4".repeat(32)}`);
    const send = async () => {
      const { payload, headers } = multipartBody("file", "a.jpg", "image/jpeg", image);
      return await app.inject({ method: "POST", url: "/verify/paid", payload, headers: { ...headers, "payment-signature": header } });
    };

    try {
      expect((await send()).json().error).toBe("settlement-unknown");
      spent = true;
      const retry = await send();
      expect(retry.statusCode).toBe(200);
      expect(retry.json().result.exact).toBe(record.id);
    } finally {
      await app.close();
    }
  });
});

// Review pass 5, answers #4: authorizationState is true for a spent, a cancelled, and somebody
// else's spend of the same authorisation, so it can never prove this request's payment on its own.
describe("proving a payment by its transfer", () => {
  const USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603" as Hex;
  const FROM = "0x3333333333333333333333333333333333333333" as Hex;
  const NONCE = `0x${"9a".repeat(32)}` as Hex;
  const HASH = `0x${"7e".repeat(32)}` as Hex;
  const payment = {
    payload: { authorization: { from: FROM, to: PAY_TO, value: "50000", nonce: NONCE } },
  } as unknown as PaymentPayload;
  const requirements = { asset: USDC, payTo: PAY_TO, amount: "50000" } as unknown as PaymentRequirements;

  const used = {
    address: USDC,
    topics: encodeEventTopics({ abi: USDC_EVENTS, eventName: "AuthorizationUsed", args: { authorizer: FROM, nonce: NONCE } }),
    data: "0x",
  };
  const moved = {
    address: USDC,
    topics: encodeEventTopics({ abi: USDC_EVENTS, eventName: "Transfer", args: { from: FROM, to: PAY_TO } }),
    data: encodeAbiParameters([{ type: "uint256" }], [50_000n]),
  };

  function chainWith(options: { state: boolean; receipt?: { status: string; logs: unknown[] } | "pending" }) {
    return {
      readContract: vi.fn(async () => options.state),
      getTransactionReceipt: vi.fn(async (): Promise<{ status: string; logs: unknown[] }> => {
        if (options.receipt === undefined || options.receipt === "pending") {
          throw new Error("Transaction receipt with hash could not be found");
        }
        return options.receipt;
      }),
    };
  }

  it("does not count a used authorisation whose transfer from this request reverted", async () => {
    const chain = chainWith({ state: true, receipt: { status: "reverted", logs: [] } });

    expect(await chainCharged(chain)(payment, requirements, [HASH])).not.toBe(true);
  });

  it("counts the transfer when this request's transaction carries it to the payee for this nonce", async () => {
    const chain = chainWith({ state: true, receipt: { status: "success", logs: [used, moved] } });

    expect(await chainCharged(chain)(payment, requirements, [HASH])).toBe(true);
  });

  it("cannot tell from a used authorisation with no transaction of its own, or one still pending", async () => {
    expect(await chainCharged(chainWith({ state: true }))(payment, requirements, [])).toBeUndefined();
    expect(await chainCharged(chainWith({ state: true, receipt: "pending" }))(payment, requirements, [HASH])).toBeUndefined();
    expect(await chainCharged(chainWith({ state: false }))(payment, requirements, [])).toBe(false);
  });

  it("hands the chain check the transaction the facilitator named for this request", async () => {
    const failed = {
      success: false,
      errorReason: "invalid_exact_evm_transaction_failed",
      errorMessage: "reverted",
      transaction: HASH,
      network: X402_NETWORK,
      headers: {},
      response: { status: 402, headers: {}, body: { error: "payment failed" } },
    };
    const settle = vi.fn().mockResolvedValue(failed);
    const charged = vi.fn(async (_payment: unknown, _requirements: unknown, _transactions: readonly string[]) => undefined);
    const image = await makeImage(65);
    const app = await buildServer({ source: sourceOf([recordFor(await fingerprint(image))]), logger: false });
    await app.register(verifyPaidRoutes, {
      payments: paymentsThatSettleWith(settle, vi.fn(async () => undefined)),
      settlementRetryDelayMs: 0,
      charged,
    });
    await app.ready();

    try {
      const { payload, headers } = multipartBody("file", "a.jpg", "image/jpeg", image);
      const response = await app.inject({
        method: "POST",
        url: "/verify/paid",
        payload,
        headers: { ...headers, "payment-signature": paymentHeaderFor(`0x${"f5".repeat(32)}`) },
      });

      expect(response.statusCode).toBe(502);
      expect(charged.mock.calls.at(-1)?.[2]).toEqual([HASH]);
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
  it("answers 502 settlement-unknown, without cancelling, when the facilitator throws on every ask", async () => {
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
    const app = await buildServer({ source: sourceOf([recordFor(await fingerprint(image))]), logger: false });
    await app.register(verifyPaidRoutes, { payments, settlementRetryDelayMs: 0 });
    await app.ready();

    try {
      const { payload, headers } = multipartBody("file", "a.jpg", "image/jpeg", image);
      const response = await app.inject({ method: "POST", url: "/verify/paid", payload, headers });

      expect(response.statusCode).toBe(502);
      expect(response.json().error).toBe("settlement-unknown");
      expect(cancel).not.toHaveBeenCalled();
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
