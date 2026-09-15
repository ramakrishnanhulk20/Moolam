import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deadlineFromChain, headTimestamp } from "@/lib/chain/time";

const reads = vi.hoisted(() => ({ getBlock: vi.fn() }));

vi.mock("@/lib/chain/client", () => ({ chain: { getBlock: reads.getBlock } }));

// The hold is measured against the wall clock, so each test runs a minute
// after the one before it and nothing is carried over between them.
let clock = 1_788_000_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  clock += 60_000;
  vi.setSystemTime(clock);
  reads.getBlock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the chain's own clock", () => {
  it("reads the head block's timestamp", async () => {
    reads.getBlock.mockResolvedValue({ timestamp: 1_788_876_542n });
    await expect(headTimestamp()).resolves.toBe(1_788_876_542n);
  });

  it("answers twice from one call inside the hold, and reads again after it", async () => {
    reads.getBlock.mockResolvedValue({ timestamp: 1_788_876_542n });

    await headTimestamp();
    await headTimestamp();
    expect(reads.getBlock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10_001);
    await headTimestamp();
    expect(reads.getBlock).toHaveBeenCalledTimes(2);
  });

  it("does not hold a failed read", async () => {
    reads.getBlock.mockRejectedValueOnce(new Error("the RPC did not answer")).mockResolvedValue({
      timestamp: 1_788_876_600n,
    });

    await expect(headTimestamp()).rejects.toThrow(/did not answer/);
    await expect(headTimestamp()).resolves.toBe(1_788_876_600n);
    expect(reads.getBlock).toHaveBeenCalledTimes(2);
  });

  it("puts the window on top of the head block, not on top of this machine's clock", async () => {
    reads.getBlock.mockResolvedValue({ timestamp: 1_788_876_542n });
    await expect(deadlineFromChain(1800n)).resolves.toBe(1_788_878_342n);
  });
});
