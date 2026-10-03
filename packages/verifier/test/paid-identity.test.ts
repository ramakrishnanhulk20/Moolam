// Covers review pass 10 on the paid route. V100: a payment header whose payer, nonce or signed fields
// cannot be read is refused 402 before the payment server or the facilitator hears of it, so every
// payment that reaches a settle has taken the in-flight mark and can be kept in the ledger. V103:
// the chain proof reads the payer and the pay-to address in any letter case, as the facilitator and
// the rest of this route do, so an answer held for such a payment is handed over once the chain
// shows it spent.
// The payment server and the RPC are stubs, so no request leaves the machine. Does NOT cover a real
// facilitator's own reading of an odd payload, or a real FiatToken receipt.

import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { HTTPRequestContext, x402HTTPResourceServer } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { encodeAbiParameters, encodeEventTopics, getAddress, parseAbi, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import { fingerprint } from "../src/fingerprint.js";
import { chainCharged, verifyPaidRoutes, type ChargedCheck } from "../src/routes/verifyPaid.js";
import { buildServer } from "../src/server.js";
import { makeImage, multipartBody, recordFor } from "./helpers.js";

const USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603" as Hex;
const PAY_TO_LOWER = "0xc5ead1e4e5c6d56e87e02317f3fb3731cb0b6ef7" as Hex;
/** The pay-to address written in capitals, which env.ts accepts and x402 passes through unchanged. */
const PAY_TO_CAPITALS = `0x${PAY_TO_LOWER.slice(2).toUpperCase()}` as Hex;
const FROM_LOWER = "0x559f357ada3a96d11aea679ec0d622e4af15f67c" as Hex;
const FROM_CAPITALS = `0x${FROM_LOWER.slice(2).toUpperCase()}` as Hex;
const PRICE = 50_000n;
const HASH = `0x${"6e".repeat(32)}` as Hex;
/** Block n was mined at BASE + n seconds. */
const BASE = 1_790_000_000n;

const USDC_EVENTS = parseAbi([
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

function authorization(nonce: Hex, from: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    from,
    to: PAY_TO_CAPITALS,
    value: String(PRICE),
    validAfter: "0",
    validBefore: String(BASE + 51_150n),
    nonce,
    ...overrides,
  };
}

function header(nonce: Hex, from: string, overrides: Record<string, unknown> = {}): string {
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      accepted: {},
      payload: { signature: `0x${"5a".repeat(65)}`, authorization: authorization(nonce, from, overrides) },
    }),
    "utf8",
  ).toString("base64");
}

function receiptFor(nonce: Hex): unknown[] {
  return [
    {
      address: USDC,
      logIndex: 3,
      topics: encodeEventTopics({ abi: USDC_EVENTS, eventName: "AuthorizationUsed", args: { authorizer: FROM_LOWER, nonce } }),
      data: "0x",
    },
    {
      address: USDC,
      logIndex: 4,
      topics: encodeEventTopics({ abi: USDC_EVENTS, eventName: "Transfer", args: { from: FROM_LOWER, to: PAY_TO_LOWER } }),
      data: encodeAbiParameters([{ type: "uint256" }], [PRICE]),
    },
  ];
}

/** The pay asset as an RPC answers it, with the payer's addresses as viem hands them back. */
function assetChain(state: { used: boolean; logs: { nonce: Hex; block: bigint }[]; receipts: Record<string, unknown[]> }) {
  return {
    readContract: vi.fn(async () => state.used),
    getBlockNumber: vi.fn(async () => 1_400n),
    getBlock: vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: BASE + blockNumber })),
    getLogs: vi.fn(async (query: { args: { authorizer: Hex; nonce: Hex }; fromBlock: bigint; toBlock: bigint }) =>
      state.logs
        .filter(
          (log) =>
            query.args.authorizer.toLowerCase() === FROM_LOWER &&
            query.args.nonce.toLowerCase() === log.nonce &&
            log.block >= query.fromBlock &&
            log.block <= query.toBlock,
        )
        .map((log) => ({ address: USDC, args: { authorizer: getAddress(FROM_LOWER), nonce: log.nonce }, transactionHash: HASH })),
    ),
    getTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => {
      const logs = state.receipts[hash];
      if (logs === undefined) throw new Error("Transaction receipt with hash could not be found");
      // After the block the payment was held at, as the real receipt's own block always is.
      return { status: "success", logs, blockNumber: 1_100n };
    }),
  };
}

/**
 * A payment server that verifies any header carrying a signature, as a facilitator reading every
 * field through BigInt() would, and refuses a nonce the chain shows spent.
 */
function paymentsWith(settle: unknown, spent: () => boolean) {
  const payments = {
    initialize: async () => undefined,
    processHTTPRequest: async (context: HTTPRequestContext) => {
      if (spent()) {
        return { type: "payment-error", response: { status: 402, headers: {}, body: { error: "invalid_exact_evm_nonce_already_used" } } };
      }
      return {
        type: "payment-verified",
        paymentPayload: decodePaymentSignatureHeader(context.adapter.getHeader("payment-signature") ?? ""),
        paymentRequirements: { asset: USDC, payTo: PAY_TO_CAPITALS, amount: String(PRICE) },
        declaredExtensions: [],
        cancellationDispatcher: { cancel: async () => undefined },
      };
    },
    processSettlement: settle,
  } as unknown as x402HTTPResourceServer;
  return { payments, processed: vi.spyOn(payments, "processHTTPRequest") };
}

async function paidApp(settle: unknown, spent: () => boolean, charged: ChargedCheck, seed: number) {
  const picture = await makeImage(seed);
  const record = recordFor(await fingerprint(picture));
  const app = await buildServer({ source: { load: async () => [record] }, logger: false });
  const { payments, processed } = paymentsWith(settle, spent);
  await app.register(verifyPaidRoutes, { payments, settlementRetryDelayMs: 0, charged, head: async () => 1_000n });
  await app.ready();
  const send = async (paymentHeader: string) => {
    const { payload, headers } = multipartBody("file", "a.jpg", "image/jpeg", picture);
    return await app.inject({ method: "POST", url: "/verify/paid", payload, headers: { ...headers, "payment-signature": paymentHeader } });
  };
  return { app, record, processed, send };
}

describe("V100: a payment whose identity cannot be read", () => {
  it("is refused 402 before the payment server is asked, and never served or settled", async () => {
    const settle = vi.fn(async () => ({ success: true, transaction: HASH, network: "eip155:143", headers: {}, requirements: {} }));
    const { app, record, processed, send } = await paidApp(settle, () => false, async () => undefined, 161);

    try {
      // A number where the client signs a string: the facilitator reads it through BigInt() and
      // accepts it, and this route could not key its in-flight mark or its ledger on it.
      const numeric = await send(header(`0x${"d1".repeat(32)}`, FROM_LOWER, { validAfter: 0 }));
      const noNonce = await send(header(`0x${"d2".repeat(32)}`, FROM_LOWER, { nonce: undefined }));
      const notBase64 = await send("not a payment at all");

      for (const refused of [numeric, noNonce, notBase64]) {
        expect(refused.statusCode).toBe(402);
        expect(refused.body).not.toContain(record.id);
      }
      expect(processed).not.toHaveBeenCalled();
      expect(settle).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  }, 60_000);
});

describe("V103: the chain proof reads addresses in any letter case", () => {
  const nonce = `0x${"d3".repeat(32)}` as Hex;
  const requirements = { asset: USDC, payTo: PAY_TO_CAPITALS, amount: String(PRICE) } as unknown as PaymentRequirements;
  const payment = (from: string) =>
    ({ payload: { authorization: authorization(nonce, from) } }) as unknown as PaymentPayload;

  it("proves a payment whose payer and pay-to address are written in capitals or with a wrong checksum", async () => {
    const chain = assetChain({ used: true, logs: [], receipts: { [HASH]: receiptFor(nonce) } });
    const charged = chainCharged(chain);
    const wrongChecksum = getAddress(FROM_LOWER).replace(/[a-f]/, (letter) => letter.toUpperCase());

    expect(wrongChecksum).not.toBe(getAddress(FROM_LOWER));
    for (const from of [FROM_CAPITALS, wrongChecksum, FROM_LOWER]) {
      expect(await charged(payment(from), requirements, [HASH], 1_000n)).toBe(true);
    }
  });

  it("hands over the answer held for such a payment once the chain shows it spent", async () => {
    const state = { used: false, logs: [] as { nonce: Hex; block: bigint }[], receipts: {} as Record<string, unknown[]> };
    const settle = vi.fn(async () => {
      throw new Error("FacilitatorTimeoutError: settle did not answer in 30000 ms");
    });
    const { app, record, send } = await paidApp(settle, () => state.used, chainCharged(assetChain(state)), 163);
    const paymentHeader = header(nonce, FROM_CAPITALS);

    try {
      const held = await send(paymentHeader);
      expect(held.statusCode).toBe(502);
      expect(held.json().error).toBe("settlement-unknown");

      state.used = true;
      state.logs = [{ nonce, block: 1_003n }];
      state.receipts = { [HASH]: receiptFor(nonce) };

      const released = await send(paymentHeader);
      expect(released.statusCode).toBe(200);
      expect(released.json().result.exact).toBe(record.id);
    } finally {
      await app.close();
    }
  }, 60_000);
});
