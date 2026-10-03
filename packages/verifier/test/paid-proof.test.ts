// Covers review pass 9 on the paid route. V81: a transfer proves only the authorisation whose
// AuthorizationUsed sits right before it in the receipt, from the pay asset, for the signed value,
// so a batch that spends three nonces beside one real transfer proves one payment, not three.
// V83: a payment held while the chain's newest block could not be read is still proven once the
// chain answers, searched from the authorisation's own time, and a repeat never moves that start
// past the transfer. V84: a remembered payment sent with another file gets exactly what an unknown
// payment gets, and a caller trickling an upload under the payer's public payment cannot hold the
// payer's own repeat off. WO-317: a receipt from before the block read at the hold proves nothing,
// so an old settlement cannot pay for a new file once the ledger entry that held it is gone.
// The facilitator and the RPC are stubs, so no request leaves the machine. Does NOT cover a real
// FiatToken receipt, a real RPC's block times, or two instances of the service.

import { PassThrough } from "node:stream";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { HTTPRequestContext, x402HTTPResourceServer } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { encodeAbiParameters, encodeEventTopics, parseAbi, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import { fingerprint } from "../src/fingerprint.js";
import { HOLD_LOOKBACK_BLOCKS, chainCharged, verifyPaidRoutes, type ChargedCheck } from "../src/routes/verifyPaid.js";
import { buildServer } from "../src/server.js";
import { paymentLedger } from "../src/x402/ledger.js";
import { makeImage, multipartBody, recordFor } from "./helpers.js";

const USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603" as Hex;
const PAY_TO = "0xC5ead1E4E5C6d56E87e02317f3fB3731cB0b6Ef7" as Hex;
const FROM = "0x3333333333333333333333333333333333333333" as Hex;
const PRICE = 50_000n;
/** Block n was mined at BASE + n seconds, so a time converts to a block by subtraction. */
const BASE = 1_790_000_000n;
const HASH = `0x${"7a".repeat(32)}` as Hex;

const USDC_EVENTS = parseAbi([
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

const requirements = { asset: USDC, payTo: PAY_TO, amount: String(PRICE) } as unknown as PaymentRequirements;

function usedLog(nonce: Hex, logIndex: number) {
  return {
    address: USDC,
    logIndex,
    topics: encodeEventTopics({ abi: USDC_EVENTS, eventName: "AuthorizationUsed", args: { authorizer: FROM, nonce } }),
    data: "0x" as Hex,
  };
}

function transferLog(value: bigint, logIndex: number) {
  return {
    address: USDC,
    logIndex,
    topics: encodeEventTopics({ abi: USDC_EVENTS, eventName: "Transfer", args: { from: FROM, to: PAY_TO } }),
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
  };
}

function paymentFor(nonce: Hex, validBefore: bigint = BASE + 51_150n): PaymentPayload {
  return {
    payload: {
      authorization: { from: FROM, to: PAY_TO, value: String(PRICE), validAfter: "0", validBefore: String(validBefore), nonce },
    },
  } as unknown as PaymentPayload;
}

/** A payment header as the x402 client builds one: validAfter "0" and a short validBefore. */
function headerFor(nonce: Hex, validBefore: bigint = BASE + 51_150n): string {
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      accepted: {},
      payload: {
        signature: `0x${"5a".repeat(65)}`,
        authorization: {
          from: FROM,
          to: PAY_TO,
          value: String(PRICE),
          validAfter: "0",
          validBefore: String(validBefore),
          nonce,
        },
      },
    }),
    "utf8",
  ).toString("base64");
}

/** The pay asset as an RPC sees it: getLogs honours the payer, the nonce and the range. */
function assetChain(state: {
  used: boolean;
  latest: bigint;
  logs?: { nonce: Hex; block: bigint; hash: Hex }[];
  receipts?: Record<string, { status: string; logs: unknown[]; blockNumber?: bigint }>;
}) {
  return {
    state,
    chain: {
      readContract: vi.fn(async () => state.used),
      getBlockNumber: vi.fn(async () => state.latest),
      getBlock: vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: BASE + blockNumber })),
      getLogs: vi.fn(async (query: { args: { authorizer: Hex; nonce: Hex }; fromBlock: bigint; toBlock: bigint }) =>
        (state.logs ?? [])
          .filter(
            (log) =>
              query.args.authorizer.toLowerCase() === FROM.toLowerCase() &&
              log.nonce === query.args.nonce.toLowerCase() &&
              log.block >= query.fromBlock &&
              log.block <= query.toBlock,
          )
          .map((log) => ({ address: USDC, args: { authorizer: FROM, nonce: log.nonce }, transactionHash: log.hash })),
      ),
      getTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => {
        const receipt = state.receipts?.[hash];
        if (receipt === undefined) throw new Error("Transaction receipt with hash could not be found");
        return receipt;
      }),
    },
  };
}

/**
 * A payment server in front of a facilitator that refuses a nonce the chain shows spent, as the
 * reference facilitator's verify does, and settles with whatever the test hands in.
 */
function paymentsWith(settle: unknown, spent: () => boolean): x402HTTPResourceServer {
  return {
    initialize: async () => undefined,
    processHTTPRequest: async (context: HTTPRequestContext) => {
      const header = context.adapter.getHeader("payment-signature") ?? "";
      if (spent()) {
        return {
          type: "payment-error",
          response: { status: 402, headers: {}, body: { error: "invalid_exact_evm_nonce_already_used" } },
        };
      }
      return {
        type: "payment-verified",
        paymentPayload: decodePaymentSignatureHeader(header),
        paymentRequirements: requirements,
        declaredExtensions: [],
        cancellationDispatcher: { cancel: async () => undefined },
      };
    },
    processSettlement: settle,
  } as unknown as x402HTTPResourceServer;
}

async function paidApp(options: {
  settle: unknown;
  spent: () => boolean;
  charged: ChargedCheck;
  head?: () => Promise<bigint | undefined>;
  seed: number;
}) {
  const ledger = paymentLedger();
  const x = await makeImage(options.seed);
  const y = await makeImage(options.seed + 1);
  const record = recordFor(await fingerprint(x));
  const app = await buildServer({ source: { load: async () => [record] }, logger: false });
  await app.register(verifyPaidRoutes, {
    payments: paymentsWith(options.settle, options.spent),
    settlementRetryDelayMs: 0,
    ledger,
    charged: options.charged,
    head: options.head ?? (async () => 1_000n),
  });
  await app.ready();
  const send = async (header: string, file: Buffer) => {
    const { payload, headers } = multipartBody("file", "a.jpg", "image/jpeg", file);
    return await app.inject({ method: "POST", url: "/verify/paid", payload, headers: { ...headers, "payment-signature": header } });
  };
  return { app, ledger, record, x, y, send };
}

describe("V81: one transfer proves one payment", () => {
  const N1 = `0x${"a1".repeat(32)}` as Hex;
  const N2 = `0x${"a2".repeat(32)}` as Hex;
  const N3 = `0x${"a3".repeat(32)}` as Hex;
  const N4 = `0x${"a4".repeat(32)}` as Hex;

  /** Which of N1, N2 and N3 the one transaction proves paid. */
  async function provenFrom(logs: unknown[]): Promise<boolean[]> {
    const { chain } = assetChain({ used: true, latest: 1_400n, receipts: { [HASH]: { status: "success", logs, blockNumber: 1_100n } } });
    const charged = chainCharged(chain);
    const answers = await Promise.all([N1, N2, N3].map((nonce) => charged(paymentFor(nonce), requirements, [HASH], 1_000n)));
    return answers.map((answer) => answer === true);
  }

  it("proves only the nonce whose own transfer carries the signed value, in the reviewer's batch", async () => {
    // The payer spends N1 with the signature the facilitator verified, and N2 and N3 with their own
    // second signatures of value 0, all in one helper transaction.
    const batch = [usedLog(N1, 0), transferLog(PRICE, 1), usedLog(N2, 2), transferLog(0n, 3), usedLog(N3, 4), transferLog(0n, 5)];
    expect(await provenFrom(batch)).toEqual([true, false, false]);

    // The same batch with the one real transfer under a fourth nonce proves none of the three.
    const elsewhere = [
      usedLog(N1, 0),
      transferLog(0n, 1),
      usedLog(N2, 2),
      transferLog(0n, 3),
      usedLog(N3, 4),
      transferLog(0n, 5),
      usedLog(N4, 6),
      transferLog(PRICE, 7),
    ];
    expect(await provenFrom(elsewhere)).toEqual([false, false, false]);
  });

  it("refuses a transfer that is not the log right after this nonce's AuthorizationUsed", async () => {
    const apart = [usedLog(N1, 0), transferLog(PRICE, 2)];
    const before = [transferLog(PRICE, 0), usedLog(N1, 1)];
    const more = [usedLog(N1, 0), transferLog(PRICE + 1n, 1)];

    for (const logs of [apart, before, more]) {
      expect((await provenFrom(logs))[0]).toBe(false);
    }
  });
});

describe("V83: a payment held while the newest block could not be read", () => {
  it("is proven once the chain answers, and a repeat never moves its search start past the transfer", async () => {
    const nonce = `0x${"b3".repeat(32)}` as Hex;
    const asset = assetChain({ used: false, latest: 51_020n });
    let head: bigint | undefined;
    const settle = vi.fn(async () => {
      throw new Error("FacilitatorTimeoutError: settle did not answer in 30000 ms");
    });
    const { app, record, x, send } = await paidApp({
      settle,
      spent: () => asset.state.used,
      charged: chainCharged(asset.chain),
      head: async () => head,
      seed: 91,
    });
    const header = headerFor(nonce);

    try {
      // Both endpoints failed the head read when the payment was held.
      const held = await send(header, x);
      expect(held.statusCode).toBe(502);
      expect(held.json().error).toBe("settlement-unknown");

      // A repeat while the chain still shows nothing, by which time the head read works and is
      // already past the block the transfer is about to land in.
      head = 60_000n;
      expect((await send(header, x)).json().error).toBe("settlement-unknown");

      asset.state.used = true;
      asset.state.latest = 60_400n;
      asset.state.logs = [{ nonce, block: 51_003n, hash: HASH }];
      asset.state.receipts = { [HASH]: { status: "success", logs: [usedLog(nonce, 3), transferLog(PRICE, 4)] } };

      const later = await send(header, x);
      expect(later.statusCode).toBe(200);
      expect(later.json().result.exact).toBe(record.id);
    } finally {
      await app.close();
    }
  }, 60_000);
});

describe("V84: the replay path confirms nothing about which file a payment was for", () => {
  for (const state of ["settled", "unknown"] as const) {
    it(`answers a candidate file with a remembered ${state} payment exactly as an unknown payment`, async () => {
      const nonce = `0x${(state === "settled" ? "c1" : "c2").repeat(32)}` as Hex;
      let spent = false;
      const settle = vi.fn(async () => {
        if (state === "unknown") throw new Error("socket hang up");
        spent = true;
        return { success: true, transaction: HASH, network: "eip155:143", headers: {}, requirements: {} };
      });
      const { app, ledger, record, x, y, send } = await paidApp({
        settle,
        spent: () => spent,
        charged: async () => (state === "unknown" ? undefined : true),
        seed: state === "settled" ? 93 : 95,
      });
      const header = headerFor(nonce);
      const key = `${FROM.toLowerCase()}:${nonce}`;

      try {
        const bought = await send(header, x);
        expect(bought.statusCode).toBe(state === "settled" ? 200 : 502);
        expect(ledger.get(key)?.state).toBe(state);
        // The transfer the first request started lands meanwhile.
        spent = true;

        const remembered = await send(header, y);
        const kept = ledger.get(key);
        ledger.forget(key);
        const unknown = await send(header, y);

        expect(remembered.statusCode).toBe(unknown.statusCode);
        expect(remembered.body).toBe(unknown.body);
        expect(remembered.body).not.toContain(record.id);
        expect(kept?.state).toBe(state);
      } finally {
        await app.close();
      }
    }, 60_000);
  }

  it("lets the payer's own repeat through while another caller trickles an upload under the same payment", async () => {
    const nonce = `0x${"c3".repeat(32)}` as Hex;
    let spent = false;
    const settle = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    const { app, record, x, y, send } = await paidApp({
      settle,
      spent: () => spent,
      charged: async () => (spent ? true : undefined),
      seed: 97,
    });
    const header = headerFor(nonce);

    try {
      expect((await send(header, x)).json().error).toBe("settlement-unknown");
      spent = true;

      const { payload, headers } = multipartBody("file", "b.jpg", "image/jpeg", y);
      const trickle = new PassThrough();
      trickle.write(payload.subarray(0, 200));
      const slow = app.inject({
        method: "POST",
        url: "/verify/paid",
        payload: trickle,
        headers: { ...headers, "payment-signature": header },
      });
      await new Promise((resolve) => setTimeout(resolve, 250));

      const repeat = await send(header, x);
      expect(repeat.statusCode).toBe(200);
      expect(repeat.json().result.exact).toBe(record.id);

      trickle.end(payload.subarray(200));
      const ended = await slow;
      expect(ended.body).not.toContain(record.id);
    } finally {
      await app.close();
    }
  }, 60_000);
});

describe("WO-317: an old settlement cannot pay for a new file", () => {
  // Both of these failed on the code before this order: landed() read a receipt's status and logs
  // and never its block, so the first payment's transaction proved the repeat once the ledger forgot it.
  const nonce = `0x${"d4".repeat(32)}` as Hex;
  const SINCE = 1_000n;
  const logs = [usedLog(nonce, 3), transferLog(PRICE, 4)];

  it("takes a receipt from the hold block or the lookback before it, and refuses one from earlier", async () => {
    const answers: (boolean | undefined)[] = [];
    for (const blockNumber of [SINCE, SINCE - HOLD_LOOKBACK_BLOCKS, SINCE - HOLD_LOOKBACK_BLOCKS - 1n, 500n]) {
      const { chain } = assetChain({ used: true, latest: 1_400n, receipts: { [HASH]: { status: "success", logs, blockNumber } } });
      answers.push(await chainCharged(chain)(paymentFor(nonce), requirements, [HASH], SINCE));
    }
    expect(answers.map((answer) => answer === true)).toEqual([true, true, false, false]);
  });

  it("does not take a receipt that names no block when the hold block is known", async () => {
    const { chain } = assetChain({ used: true, latest: 1_400n, receipts: { [HASH]: { status: "success", logs } } });
    expect(await chainCharged(chain)(paymentFor(nonce), requirements, [HASH], SINCE)).not.toBe(true);
  });

  it("answers no 200 to a new file when the facilitator names the first payment's transaction after the ledger entry is gone", async () => {
    let head = 1_000n;
    let facilitator: "settles" | "names-the-old-one" = "settles";
    const asset = assetChain({
      used: true,
      latest: 1_400n,
      receipts: { [HASH]: { status: "success", logs, blockNumber: 1_002n } },
    });
    const settle = vi.fn(async () =>
      facilitator === "settles"
        ? { success: true, transaction: HASH, network: "eip155:143", headers: {}, requirements: {} }
        : {
            success: false,
            errorReason: "settlement failed",
            transaction: HASH,
            network: "eip155:143",
            headers: {},
            response: { status: 402, headers: {}, body: {} },
          },
    );
    const { app, ledger, x, y, send } = await paidApp({
      settle,
      spent: () => false,
      charged: chainCharged(asset.chain),
      head: async () => head,
      seed: 99,
    });
    const header = headerFor(nonce);

    try {
      expect((await send(header, x)).statusCode).toBe(200);

      // Ten minutes on: the ledger entry has expired and the chain has moved well past the transfer.
      ledger.forget(`${FROM.toLowerCase()}:${nonce}`);
      head = 1_300n;
      facilitator = "names-the-old-one";

      const again = await send(header, y);
      expect(again.statusCode).toBe(502);
      expect(again.json().error).toBe("settlement-unknown");
    } finally {
      await app.close();
    }
  }, 60_000);
});
