import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";

const held = vi.hoisted(() => ({
  readContract: vi.fn(),
  /** What every held read was filed under, and the options it was filed with. */
  filed: [] as { keyParts: string[]; options: { revalidate?: number; tags?: string[] } }[],
  store: new Map<string, unknown>(),
}));

// Next's cache needs a request behind it, which a node test has none of. The
// stand-in keeps answers under the same key Next would use, so a second ask is
// served from the hold, and it keeps no throw, which is how Next treats one.
vi.mock("next/cache", () => ({
  unstable_cache: (
    fn: (...args: unknown[]) => Promise<unknown>,
    keyParts: string[],
    options: { revalidate?: number; tags?: string[] },
  ) => {
    held.filed.push({ keyParts, options });
    return async (...args: unknown[]) => {
      const key = [...keyParts, JSON.stringify(args)].join("|");
      if (held.store.has(key)) {
        return held.store.get(key);
      }
      const answer = await fn(...args);
      held.store.set(key, JSON.parse(JSON.stringify(answer)) as unknown);
      return held.store.get(key);
    };
  },
}));

vi.mock("@/lib/chain/client", () => ({
  chain: { readContract: held.readContract },
  addresses: {
    registry: "0x0000000000000000000000000000000000000001",
    policy: "0x0000000000000000000000000000000000000002",
  },
  registryAbi: [],
  policyAbi: [],
  CACHE_TAGS: { index: "moolam-index", chain: "moolam-chain", metadata: "moolam-metadata" },
  HOLD_SECONDS: 60,
  REPUTATION_REGISTRY: "0x0000000000000000000000000000000000000003",
  gatewayUrl: (uri: string) => uri,
}));

const { heldPassportRecord, passportTag } = await import("@/lib/chain/registry");

const ID = `0x${"CD".repeat(32)}` as Hex;
const CREATOR = "0x551610a063BcAd79e6bd25dc55cEe92Ba3FD960a" as Hex;

/** The registry's answers, one per call the bundle makes. registeredAt 0 is an id it never saw. */
function registry(registeredAt: bigint) {
  return ({ functionName }: { functionName: string }) => {
    switch (functionName) {
      case "getPassport":
        return Promise.resolve({
          registeredAt,
          creator: CREATOR,
          generatorAgentId: 10_248n,
          phash: 2n ** 70n,
          kind: 0,
          disputed: false,
        });
      case "getAttestations":
        return Promise.resolve([{ receiver: CREATOR, matched: true, distance: 0, at: 1_788_876_542n }]);
      case "childCount":
        return Promise.resolve(0n);
      case "ownerOf":
        return Promise.resolve(CREATOR);
      case "getDispute":
        return Promise.resolve({ challenger: CREATOR, bond: 10n ** 17n, status: 1, openedAt: 1_788_876_999n });
      case "getPasskey":
        return Promise.resolve(["0x01", "0x02"]);
      default:
        throw new Error(`unexpected read ${functionName}`);
    }
  };
}

beforeEach(() => {
  held.readContract.mockReset();
  held.filed.length = 0;
  held.store.clear();
});

describe("the name a passport's held reads are filed under", () => {
  it("is the id in lower case, whatever case the link carried", () => {
    expect(passportTag(ID)).toBe(`passport:0x${"cd".repeat(32)}`);
  });
});

describe("holding one passport's chain reads", () => {
  it("reads the registry once for a render that asks twice, which is the page plus its tab title", async () => {
    held.readContract.mockImplementation(registry(1_788_876_542n));

    const first = await heldPassportRecord(ID);
    const second = await heldPassportRecord(ID);

    expect(first.passport?.id).toBe(ID);
    expect(second.passport?.id).toBe(ID);
    expect(held.readContract).toHaveBeenCalledTimes(6);
  });

  it("files the answer under this passport alone, for a minute, so one write drops one page", async () => {
    held.readContract.mockImplementation(registry(1_788_876_542n));

    await heldPassportRecord(ID);

    expect(held.filed[0].keyParts).toEqual(["moolam-passport-record", `0x${"cd".repeat(32)}`]);
    expect(held.filed[0].options).toEqual({ revalidate: 60, tags: ["moolam-chain", passportTag(ID)] });
  });

  it("hands back the counters as bigints after the hold, where they crossed as strings", async () => {
    held.readContract.mockImplementation(registry(1_788_876_542n));

    await heldPassportRecord(ID);
    const again = await heldPassportRecord(ID);

    expect(again.passport?.registeredAt).toBe(1_788_876_542n);
    expect(again.passport?.phash).toBe(2n ** 70n);
    expect(again.attestations[0].at).toBe(1_788_876_542n);
    expect(again.dispute?.bond).toBe(10n ** 17n);
    expect(again.hasPasskey).toBe(true);
  });

  it("never keeps an id the registry has no record of, so a new passport is not missing for a minute", async () => {
    held.readContract.mockImplementation(registry(0n));

    await expect(heldPassportRecord(ID)).resolves.toMatchObject({ passport: null, attestations: [] });
    await heldPassportRecord(ID);

    expect(held.readContract).toHaveBeenCalledTimes(2);
  });
});
