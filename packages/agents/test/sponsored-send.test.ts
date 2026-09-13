// Covers how a sponsored send from a Privy wallet is handled when Privy answers without a
// transaction hash: waiting for the hash, telling a dead transaction from one still in flight,
// and the bind step refusing to resend once the passkey bind has already landed.
// Does NOT cover Privy's live sponsorship behaviour, which only proofs/privy.txt shows, and does
// not touch the chain: every Privy call and every chain read here is a stub.

import { APIError } from "@privy-io/node";
import { WaitForTransactionReceiptTimeoutError, type Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendStub = vi.fn();

vi.mock("../src/privy/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/privy/client.js")>();
  return { ...actual, privy: () => fakeClient, ownerContext: () => ({}) };
});

vi.mock("../src/privy/serverWallet.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/privy/serverWallet.js")>();
  return { ...actual, sendFromWallet: (...args: unknown[]) => sendStub(...args) };
});

const { bindCreatorPasskey, isPrivyRefusal } = await import("../scripts/prove-privy.js");
const { awaitPrivyHash, SponsoredSendFailed, SponsoredSendPending } = await import(
  "../src/privy/serverWallet.js"
);

// The mock above replaces sendFromWallet for the bind step, so this test asks for the real one.
const { sendFromWallet } = await vi.importActual<typeof import("../src/privy/serverWallet.js")>(
  "../src/privy/serverWallet.js",
);
const { MONAD_MAINNET } = await import("../src/chain/addresses.js");
const { bindDigest } = await import("../src/chain/eip712.js");
const { SoftwarePasskey } = await import("../src/chain/passkey.js");

interface FakeTransaction {
  id: string;
  status: string;
  transaction_hash: string | null;
  user_operation_hash?: string;
}

const HASH = "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex;
const REGISTRY = "0xa19188801E5DC93CD925884d73e4DaFc2bcb80C0" as Hex;
const CREATOR = "0x85a88Ca81ff5f681D96AB86fa60ccB8452A139a6" as Hex;

let replies: FakeTransaction[] = [];
let sendReply: unknown;
/** How many of the next polls answer with a network failure instead of a record. */
let failedPolls = 0;

/** Answers each poll with the next reply, then repeats the last one for as long as it is asked. */
const fakeClient = {
  transactions: () => ({
    get: async (id: string) => {
      if (failedPolls > 0) {
        failedPolls -= 1;
        throw new Error(`Privy answered 503 for ${id}`);
      }
      const next = replies.length > 1 ? replies.shift() : replies[0];
      return { ...(next as FakeTransaction), id };
    },
  }),
  wallets: () => ({ ethereum: () => ({ sendTransaction: async () => sendReply }) }),
} as never;

/** Keeps a retried poll out of the test output while still proving it was reported. */
const warnings: string[] = [];
const quiet = { warn: (_details: Record<string, unknown>, message: string) => warnings.push(message) };

beforeEach(() => {
  replies = [];
  failedPolls = 0;
  warnings.length = 0;
  sendStub.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("awaitPrivyHash", () => {
  it("returns the hash Privy reports on a later poll", async () => {
    replies = [
      { id: "tx-1", status: "pending", transaction_hash: null },
      { id: "tx-1", status: "confirmed", transaction_hash: HASH },
    ];

    await expect(awaitPrivyHash("tx-1", { timeoutMs: 5_000, pollMs: 5 })).resolves.toBe(HASH);
    expect(replies).toHaveLength(1);
  });

  it("throws SponsoredSendFailed when Privy says the transaction reverted", async () => {
    replies = [{ id: "tx-2", status: "execution_reverted", transaction_hash: null }];

    await expect(awaitPrivyHash("tx-2", { timeoutMs: 5_000, pollMs: 5 })).rejects.toMatchObject({
      name: "SponsoredSendFailed",
      transactionId: "tx-2",
      status: "execution_reverted",
    });
  });

  it("reads the dead status before the hash, so a reverted transaction is never handed back", async () => {
    replies = [{ id: "tx-8", status: "execution_reverted", transaction_hash: HASH }];

    await expect(awaitPrivyHash("tx-8", { timeoutMs: 5_000, pollMs: 5 })).rejects.toMatchObject({
      name: "SponsoredSendFailed",
      status: "execution_reverted",
      hash: HASH,
    });
  });

  it("keeps polling after a poll that failed and takes the hash from the next one", async () => {
    failedPolls = 1;
    replies = [{ id: "tx-9", status: "confirmed", transaction_hash: HASH }];

    await expect(
      awaitPrivyHash("tx-9", { timeoutMs: 5_000, pollMs: 5, log: quiet }),
    ).resolves.toBe(HASH);
    expect(warnings).toHaveLength(1);
  });

  it("throws SponsoredSendPending when the wait runs out with the send still in flight", async () => {
    vi.useFakeTimers();
    replies = [{ id: "tx-3", status: "broadcasted", transaction_hash: null }];

    const waiting = awaitPrivyHash("tx-3", { timeoutMs: 60_000, pollMs: 1_000 });
    const settled = expect(waiting).rejects.toBeInstanceOf(SponsoredSendPending);
    await vi.advanceTimersByTimeAsync(61_000);
    await settled;
  });
});

describe("sendFromWallet", () => {
  it("waits for the hash instead of returning the empty one a sponsored send comes back with", async () => {
    sendReply = {
      caip2: "eip155:143",
      hash: "",
      transaction_id: "tx-4",
      user_operation_hash: "0xuo",
    };
    replies = [
      { id: "tx-4", status: "broadcasted", transaction_hash: null },
      { id: "tx-4", status: "confirmed", transaction_hash: HASH },
    ];

    const sent = await sendFromWallet("wallet-1", {
      to: REGISTRY,
      gasLimit: 400_000n,
      chainId: MONAD_MAINNET.chainId,
      sponsor: true,
      context: {},
    });

    expect(sent).toEqual({
      hash: HASH,
      sponsored: true,
      transactionId: "tx-4",
      userOperationHash: "0xuo",
    });
  });
});

describe("the refusal classifier", () => {
  it("calls a 400 policy violation a refusal", () => {
    const refusal = new APIError(400, { code: "policy_violation" }, "denied", undefined);
    expect(isPrivyRefusal(refusal)).toBe(true);
  });

  it("does not call a pending sponsored send or a viem receipt timeout a refusal", () => {
    expect(isPrivyRefusal(new SponsoredSendPending("tx-5", 60_000))).toBe(false);
    expect(isPrivyRefusal(new SponsoredSendFailed("tx-5", "failed"))).toBe(false);
    expect(isPrivyRefusal(new WaitForTransactionReceiptTimeoutError({ hash: HASH }))).toBe(false);
    expect(isPrivyRefusal(new APIError(502, { code: "bad_gateway" }, "upstream", undefined))).toBe(
      false,
    );
  });
});

describe("the bind step", () => {
  const passkey = SoftwarePasskey.random();

  /** A context whose chain reads answer from these variables rather than from Monad. */
  function context(nonces: bigint[]) {
    const domain = {
      name: "Moolam",
      version: "1",
      chainId: MONAD_MAINNET.chainId,
      verifyingContract: REGISTRY,
    } as const;
    return {
      addresses: { registry: REGISTRY, chainId: MONAD_MAINNET.chainId },
      publicClient: {
        estimateGas: async () => 300_000n,
        waitForTransactionReceipt: async () => ({ status: "success" }),
      },
      registry: {
        domain,
        bindNonce: async () => nonces.shift() ?? 0n,
        hashBind: async (wallet: Hex, qx: Hex, qy: Hex, nonce: bigint) =>
          bindDigest(wallet, qx, qy, nonce, domain),
      },
      say: () => {},
    } as never;
  }

  it("reports the sponsored bind that landed and sends no second bind", async () => {
    sendStub.mockRejectedValueOnce(new SponsoredSendPending("tx-6", 60_000));
    replies = [
      { id: "tx-6", status: "confirmed", transaction_hash: HASH, user_operation_hash: "0xuo" },
    ];

    const bound = await bindCreatorPasskey(
      context([3n, 4n]),
      { id: "wallet-2", address: CREATOR },
      passkey,
      {},
    );

    expect(bound.hash).toBe(HASH);
    expect(bound.sponsored).toBe(true);
    expect(sendStub).toHaveBeenCalledTimes(1);
  });

  it("refuses to guess when the nonce did not move, naming the transaction id", async () => {
    sendStub.mockRejectedValueOnce(new SponsoredSendPending("tx-7", 60_000));

    await expect(
      bindCreatorPasskey(context([3n, 3n]), { id: "wallet-2", address: CREATOR }, passkey, {}),
    ).rejects.toThrow(/tx-7/);
    expect(sendStub).toHaveBeenCalledTimes(1);
  });
});
