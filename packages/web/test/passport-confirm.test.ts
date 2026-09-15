// What the panel is allowed to believe about an edit that is out on the network. Nothing here
// touches the chain: the two registry reads and the receipt are stubbed, and the clock is fake.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { confirmEdit } from "@/lib/passport/confirm";
import { ConfirmTimeout } from "@/lib/studio/confirm";

const reads = vi.hoisted(() => ({
  getPassport: vi.fn(),
  getChildren: vi.fn(),
  getTransactionReceipt: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
}));

vi.mock("@/lib/chain/client", () => ({
  chain: {
    getTransactionReceipt: reads.getTransactionReceipt,
    waitForTransactionReceipt: reads.waitForTransactionReceipt,
  },
}));

// Reached only through the shared ConfirmTimeout, and neither one runs in this file.
vi.mock("@/lib/data/passports", () => ({ passportRegistration: vi.fn() }));
vi.mock("@/lib/data/source", () => ({ activeSource: () => "chain" }));

vi.mock("@/lib/chain/registry", () => ({
  CHILD_PAGE_SIZE: 48,
  getPassport: reads.getPassport,
  getChildren: reads.getChildren,
}));

const PARENT = `0x${"3f".repeat(32)}` as Hex;
const CHILD = `0x${"ab".repeat(32)}` as Hex;
const HASH = `0x${"1c".repeat(32)}` as Hex;

/** One page of the parent's edits, the shape the paged read answers with. */
function page(items: Hex[], total = items.length) {
  return { items, total };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  reads.getPassport.mockReset().mockResolvedValue(null);
  reads.getChildren.mockReset().mockResolvedValue(page([]));
  reads.getTransactionReceipt.mockReset().mockResolvedValue({ blockNumber: 41_273_109n });
  reads.waitForTransactionReceipt.mockReset().mockReturnValue(new Promise(() => undefined));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("waiting for an edit the service named", () => {
  it("polls the child passport when the send came back without a hash, instead of giving up at once", async () => {
    reads.getPassport.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValue({ id: CHILD });
    reads.getChildren.mockResolvedValue(page([CHILD], 12));

    const confirming = confirmEdit({ parentId: PARENT, childId: CHILD });
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(confirming).resolves.toMatchObject({ children: [CHILD], total: 12 });
    expect(reads.getPassport.mock.calls.length).toBeGreaterThan(2);
    expect(reads.waitForTransactionReceipt).not.toHaveBeenCalled();
  });

  it("carries on through a read that throws, because an RPC blip is not an answer", async () => {
    reads.getPassport.mockRejectedValueOnce(new Error("the RPC dropped the connection")).mockResolvedValue({ id: CHILD });
    reads.getChildren.mockResolvedValue(page([CHILD], 1));

    const confirming = confirmEdit({ parentId: PARENT, childId: CHILD, hash: HASH });
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(confirming).resolves.toMatchObject({ hash: HASH, blockNumber: 41_273_109n });
  });

  it("never calls the send done when the lineage read fails for the whole window", async () => {
    reads.getPassport.mockResolvedValue({ id: CHILD });
    reads.getChildren.mockRejectedValue(new Error("the RPC dropped the connection"));

    const confirming = confirmEdit({ parentId: PARENT, childId: CHILD });
    const thrown = confirming.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(25_000);

    expect(await thrown).toBeInstanceOf(ConfirmTimeout);
  });

  it("shows a count from a read that succeeded when the newest page does not hold the child yet", async () => {
    reads.getPassport.mockResolvedValue({ id: CHILD });
    reads.getChildren
      .mockRejectedValueOnce(new Error("the RPC dropped the connection"))
      .mockResolvedValue(page([`0x${"cd".repeat(32)}` as Hex], 60));

    const confirming = confirmEdit({ parentId: PARENT, childId: CHILD });
    await vi.advanceTimersByTimeAsync(25_000);

    await expect(confirming).resolves.toMatchObject({ total: 60 });
  });

  it("gives up at the end of the window with the line that never suggests sending again", async () => {
    reads.getPassport.mockResolvedValue(null);

    const confirming = confirmEdit({ parentId: PARENT, childId: CHILD, hash: HASH });
    const thrown = confirming.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(95_000);

    const error = await thrown;
    expect(error).toBeInstanceOf(ConfirmTimeout);
    expect((error as Error).message).toMatch(/must not be sent again/);
  });
});

describe("waiting for an edit whose answer never came back", () => {
  it("watches the parent's own count, and one more edit than the first read is the edit landing", async () => {
    reads.getChildren.mockResolvedValueOnce(page([CHILD], 4)).mockResolvedValue(page([CHILD], 5));

    const confirming = confirmEdit({ parentId: PARENT });
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(confirming).resolves.toMatchObject({ total: 5 });
    expect(reads.getPassport).not.toHaveBeenCalled();
  });

  it("keeps waiting while the count stands still, and never reports a send that failed", async () => {
    reads.getChildren.mockResolvedValue(page([CHILD], 4));

    const confirming = confirmEdit({ parentId: PARENT });
    const thrown = confirming.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(95_000);

    expect(await thrown).toBeInstanceOf(ConfirmTimeout);
  });
});
