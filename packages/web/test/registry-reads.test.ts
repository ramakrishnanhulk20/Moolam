import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { ATTESTATION_CAP, getAttestations, getChildren, getPassport } from "@/lib/chain/registry";

const reads = vi.hoisted(() => ({ readContract: vi.fn() }));

vi.mock("@/lib/chain/client", () => ({
  chain: { readContract: reads.readContract },
  addresses: { registry: "0x0000000000000000000000000000000000000001", policy: "0x0000000000000000000000000000000000000002" },
  registryAbi: [],
  policyAbi: [],
  CACHE_TAGS: { index: "index", chain: "chain", metadata: "metadata" },
  HOLD_SECONDS: 60,
  REPUTATION_REGISTRY: "0x0000000000000000000000000000000000000003",
  gatewayUrl: (uri: string) => uri,
}));

const ID = `0x${"ab".repeat(32)}` as Hex;

function childIds(count: number): Hex[] {
  return Array.from({ length: count }, (_, i) => `0x${i.toString(16).padStart(64, "0")}` as Hex);
}

/** The arguments of the readContract call at this position. */
function callArgs(at: number): unknown[] {
  return (reads.readContract.mock.calls[at][0] as { args: unknown[] }).args;
}

beforeEach(() => {
  reads.readContract.mockReset();
});

describe("reading one passport", () => {
  it("asks the chain once and treats a zeroed record as missing", async () => {
    reads.readContract.mockResolvedValue({ registeredAt: 0n, creator: `0x${"00".repeat(20)}` });

    await expect(getPassport(ID)).resolves.toBeNull();
    expect(reads.readContract).toHaveBeenCalledTimes(1);
  });

  it("asks the chain once for a record that is there, and carries the id back", async () => {
    reads.readContract.mockResolvedValue({ registeredAt: 1_788_876_542n, kind: 0 });

    await expect(getPassport(ID)).resolves.toMatchObject({ id: ID, registeredAt: 1_788_876_542n });
    expect(reads.readContract).toHaveBeenCalledTimes(1);
  });
});

describe("reading the re-checks on a passport", () => {
  it("reads the contract's whole cap in one call, with no count read first", async () => {
    reads.readContract.mockResolvedValue([{ matched: true }]);

    await expect(getAttestations(ID)).resolves.toHaveLength(1);
    expect(reads.readContract).toHaveBeenCalledTimes(1);
    expect(callArgs(0)).toEqual([ID, 0n, ATTESTATION_CAP]);
  });
});

describe("reading a page of edits", () => {
  it("takes the newest page off the end of a long list and never the whole list", async () => {
    reads.readContract.mockResolvedValueOnce(140n).mockResolvedValueOnce(childIds(48));

    const page = await getChildren(ID, { newestFirst: true, size: 48 });

    expect(callArgs(1)).toEqual([ID, 92n, 48n]);
    expect(page.total).toBe(140);
    expect(page.items).toHaveLength(48);
    // The contract hands a page back oldest first, so the newest page is reversed.
    expect(page.items[0]).toBe(`0x${(47).toString(16).padStart(64, "0")}`);
  });

  it("starts at the beginning when there is less than a page", async () => {
    reads.readContract.mockResolvedValueOnce(3n).mockResolvedValueOnce(childIds(3));

    const page = await getChildren(ID, { newestFirst: true, size: 48 });

    expect(callArgs(1)).toEqual([ID, 0n, 48n]);
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(3);
  });

  it("keeps the contract's order when the oldest page was asked for", async () => {
    reads.readContract.mockResolvedValueOnce(90n).mockResolvedValueOnce(childIds(10));

    const page = await getChildren(ID, { newestFirst: false, size: 10 });

    expect(callArgs(1)).toEqual([ID, 0n, 10n]);
    expect(page.items[0]).toBe(`0x${(0).toString(16).padStart(64, "0")}`);
  });

  it("does not read a page at all for a passport nobody has edited", async () => {
    reads.readContract.mockResolvedValueOnce(0n);

    await expect(getChildren(ID, { newestFirst: true, size: 48 })).resolves.toEqual({ items: [], total: 0 });
    expect(reads.readContract).toHaveBeenCalledTimes(1);
  });

  it("still answers the old whole-list call the edit panel makes today", async () => {
    reads.readContract.mockResolvedValueOnce(2n).mockResolvedValueOnce(childIds(2));

    await expect(getChildren(ID)).resolves.toEqual(childIds(2));
    expect(callArgs(1)).toEqual([ID, 0n, 2n]);
  });
});
