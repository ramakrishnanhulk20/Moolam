import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { ConfirmTimeout } from "@/lib/studio/confirm";

// The wait underneath is the shared one in lib/chain/watch, so the chain client
// and the two registry reads are all this file has to stand in for.
const reads = vi.hoisted(() => ({
  getDispute: vi.fn(),
  withdrawable: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
  getTransactionReceipt: vi.fn(),
}));

vi.mock("@/lib/chain/client", () => ({
  chain: {
    waitForTransactionReceipt: reads.waitForTransactionReceipt,
    getTransactionReceipt: reads.getTransactionReceipt,
  },
}));

vi.mock("@/lib/chain/registry", () => ({
  DisputeStatus: { None: 0, Open: 1, Upheld: 2, Rejected: 3 },
  getDispute: reads.getDispute,
  withdrawable: reads.withdrawable,
  bindNonce: vi.fn(),
  getPassport: vi.fn(),
}));

vi.mock("@/lib/data/passports", () => ({ passportRegistration: vi.fn() }));
vi.mock("@/lib/data/source", () => ({ activeSource: () => "chain" }));

const { confirmFlag, confirmResolve, confirmWithdraw, outcomeOf } = await import("@/lib/disputes/confirm");

const PASSPORT = `0x${"5c".repeat(32)}` as Hex;
const HASH = `0x${"3f".repeat(32)}` as Hex;
const CHALLENGER = "0x85a88Ca81Ff5F681D96AB86fA60ccB8452a139a6" as Hex;
const RESOLVER = "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c" as Hex;

function dispute(status: number, challenger: Hex = CHALLENGER) {
  return { challenger, bond: 1n, openedAt: 1_788_961_533, evidenceHash: `0x${"11".repeat(32)}`, status };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  reads.waitForTransactionReceipt.mockImplementation(() => new Promise(() => undefined));
  reads.getTransactionReceipt.mockResolvedValue({ blockNumber: 41_273_109n });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const read of Object.values(reads)) {
    read.mockReset();
  }
});

describe("waiting for a flag to show up on the registry", () => {
  it("carries on after a read that throws, and answers on the one that follows", async () => {
    reads.getDispute
      .mockRejectedValueOnce(new Error("the RPC dropped the connection"))
      .mockResolvedValue(dispute(1));

    const waiting = confirmFlag({ passportId: PASSPORT, challenger: CHALLENGER, hash: HASH });
    await vi.advanceTimersByTimeAsync(2_000);

    const landed = await waiting;
    expect(landed.dispute?.status).toBe(1);
    expect(landed.blockNumber).toBe(41_273_109n);
    expect(reads.getDispute.mock.calls.length).toBeGreaterThan(1);
  });

  it("ignores an open dispute somebody else opened on the same passport", async () => {
    reads.getDispute.mockResolvedValue(dispute(1, RESOLVER));

    const waiting = confirmFlag({ passportId: PASSPORT, challenger: CHALLENGER, hash: HASH });
    const thrown = waiting.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(91_000);

    expect(await thrown).toBeInstanceOf(ConfirmTimeout);
  });

  it("carries the challenger's own account on a window that ran out", async () => {
    reads.getDispute.mockResolvedValue(null);

    const waiting = confirmFlag({ passportId: PASSPORT, challenger: CHALLENGER, hash: HASH });
    const thrown = waiting.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(91_000);

    const error = await thrown;
    expect((error as ConfirmTimeout).wallet).toBe(CHALLENGER);
    expect((error as ConfirmTimeout).hash).toBe(HASH);
  });
});

describe("waiting for a dispute to be settled", () => {
  it("reads which way it went off the registry, not off the button that was pressed", async () => {
    // The desk pressed uphold. The registry says rejected, so rejected is the answer.
    reads.getDispute.mockResolvedValueOnce(dispute(1)).mockResolvedValue(dispute(3));

    const waiting = confirmResolve({ passportId: PASSPORT, wallet: RESOLVER, hash: HASH });
    await vi.advanceTimersByTimeAsync(2_000);

    const landed = await waiting;
    expect(landed.outcome).toBe("rejected");
    expect(landed.dispute?.status).toBe(3);
  });

  it("says upheld when that is what the record holds", async () => {
    reads.getDispute.mockResolvedValue(dispute(2));

    const waiting = confirmResolve({ passportId: PASSPORT, wallet: RESOLVER, hash: HASH });
    await vi.advanceTimersByTimeAsync(1_000);

    expect((await waiting).outcome).toBe("upheld");
  });

  it("carries the resolver's account on a window that ran out", async () => {
    reads.getDispute.mockResolvedValue(dispute(1));

    const waiting = confirmResolve({ passportId: PASSPORT, wallet: RESOLVER, hash: HASH });
    const thrown = waiting.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(91_000);

    expect((await thrown as ConfirmTimeout).wallet).toBe(RESOLVER);
  });

  it("says nothing about a dispute the registry has not settled", () => {
    expect(outcomeOf(null)).toBeNull();
    expect(outcomeOf(undefined)).toBeNull();
    expect(outcomeOf(dispute(1) as never)).toBeNull();
  });
});

describe("waiting for a withdraw", () => {
  it("answers on the credit falling, and survives a read that throws on the way", async () => {
    reads.withdrawable
      .mockResolvedValueOnce(5n)
      .mockRejectedValueOnce(new Error("the RPC dropped the connection"))
      .mockResolvedValue(0n);

    const waiting = confirmWithdraw({ wallet: RESOLVER, owedBefore: 5n, hash: HASH });
    await vi.advanceTimersByTimeAsync(3_000);

    expect((await waiting).hash).toBe(HASH);
  });

  it("carries the account on a window that ran out, so the copy can say where to look", async () => {
    reads.withdrawable.mockResolvedValue(5n);

    const waiting = confirmWithdraw({ wallet: RESOLVER, owedBefore: 5n, hash: HASH });
    const thrown = waiting.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(91_000);

    expect((await thrown as ConfirmTimeout).wallet).toBe(RESOLVER);
  });
});
