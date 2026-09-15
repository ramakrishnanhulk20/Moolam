import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { Aborted, Reverted, watchState } from "@/lib/chain/watch";
import { ConfirmTimeout } from "@/lib/studio/confirm";

const reads = vi.hoisted(() => ({ waitForTransactionReceipt: vi.fn() }));

vi.mock("@/lib/chain/client", () => ({ chain: { waitForTransactionReceipt: reads.waitForTransactionReceipt } }));
vi.mock("@/lib/chain/registry", () => ({ bindNonce: vi.fn(), getPassport: vi.fn() }));
vi.mock("@/lib/data/passports", () => ({ passportRegistration: vi.fn() }));
vi.mock("@/lib/data/source", () => ({ activeSource: () => "chain" }));

const HASH = `0x${"ef".repeat(32)}` as Hex;
const WINDOW = { windowMs: 90_000, pollMs: 1_000 };

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  reads.waitForTransactionReceipt.mockReset();
});

describe("waiting for a write by the state it changes", () => {
  it("carries on after a read that throws, and answers on the one that follows", async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error("the RPC dropped the connection"))
      .mockResolvedValue(7n);

    const watching = watchState({ read, done: (state: bigint) => state > 5n, ...WINDOW });
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(watching).resolves.toEqual({ state: 7n, hash: undefined, receiptStatus: undefined });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("keeps polling until the state says the write landed", async () => {
    const read = vi.fn().mockResolvedValueOnce(3n).mockResolvedValueOnce(3n).mockResolvedValue(4n);

    const watching = watchState({ read, done: (state: bigint) => state > 3n, ...WINDOW });
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(watching).resolves.toMatchObject({ state: 4n });
    expect(reads.waitForTransactionReceipt).not.toHaveBeenCalled();
  });

  it("calls a reverted receipt what it is, and stops", async () => {
    reads.waitForTransactionReceipt.mockResolvedValue({ status: "reverted" });
    const read = vi.fn().mockResolvedValue(null);

    const watching = watchState({ read, done: (state: unknown) => state !== null, hash: HASH, ...WINDOW });
    const thrown = watching.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2_000);

    const error = await thrown;
    expect(error).toBeInstanceOf(Reverted);
    expect((error as Reverted).hash).toBe(HASH);
  });

  it("marks the receipt when it was mined and the read then shows the write", async () => {
    reads.waitForTransactionReceipt.mockResolvedValue({ status: "success" });
    const read = vi.fn().mockResolvedValueOnce(null).mockResolvedValue("there");

    const watching = watchState({ read, done: (state: unknown) => state !== null, hash: HASH, ...WINDOW });
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(watching).resolves.toEqual({ state: "there", hash: HASH, receiptStatus: "success" });
  });

  it("gives up at the end of the window and never suggests sending again", async () => {
    const read = vi.fn().mockResolvedValue(null);
    reads.waitForTransactionReceipt.mockReturnValue(new Promise(() => undefined));

    const watching = watchState({ read, done: (state: unknown) => state !== null, hash: HASH, ...WINDOW });
    const thrown = watching.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(95_000);

    const error = await thrown;
    expect(error).toBeInstanceOf(ConfirmTimeout);
    expect((error as ConfirmTimeout).hash).toBe(HASH);
    expect((error as Error).message).toMatch(/must not be sent again/);
  });

  it("stops when the screen drops the wait", async () => {
    const controller = new AbortController();
    const read = vi.fn().mockResolvedValue(null);

    const watching = watchState({
      read,
      done: (state: unknown) => state !== null,
      signal: controller.signal,
      ...WINDOW,
    });
    const thrown = watching.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(2_000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await thrown).toBeInstanceOf(Aborted);
    const readsSoFar = read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(read).toHaveBeenCalledTimes(readsSoFar);
  });
});
