import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";

const reads = vi.hoisted(() => ({ getTransaction: vi.fn(), keys: [] as string[][] }));

// Next's cache needs a request behind it, which a node test has none of. The
// stand-in runs the read and keeps the key, so the test can still check the
// answer is held per transaction rather than under one shared name.
vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => Promise<unknown>, keyParts: string[]) => {
    reads.keys.push(keyParts);
    return fn;
  },
}));

const SIMULATION = "0x9eF6468C5f37b976E57d52054c693269479A784d";
const NETWORK = "0x76c9cf548b4179F8901cda1f8623568b58215E62";

vi.mock("@/lib/chain/client", () => ({
  chain: { getTransaction: reads.getTransaction },
  addresses: { simulationForwarder: SIMULATION, forwarder: NETWORK },
  CACHE_TAGS: { index: "index", chain: "chain", metadata: "metadata" },
}));

const { heldReportDelivery } = await import("@/lib/chain/reports");

/** A different hash per case, so one answer is never served from another's hold. */
function hash(nth: number): Hex {
  return `0x${nth.toString(16).padStart(64, "0")}` as Hex;
}

beforeEach(() => {
  reads.getTransaction.mockReset();
  reads.keys.length = 0;
});

/**
 * The passport card tells a reader whether a re-check came from one machine or
 * from the live network. That label is only worth printing if it is the chain's
 * own answer, so it is read off the report transaction rather than configured.
 */
describe("which forwarder delivered a report", () => {
  it("says simulation when the report went to the simulation forwarder", async () => {
    reads.getTransaction.mockResolvedValue({ to: SIMULATION.toLowerCase() });

    await expect(heldReportDelivery(hash(1))).resolves.toBe("simulation");
    expect(reads.getTransaction).toHaveBeenCalledWith({ hash: hash(1) });
    expect(reads.keys[0]).toEqual(["moolam-report-delivery", hash(1)]);
  });

  it("says network when the report went to the live network forwarder", async () => {
    reads.getTransaction.mockResolvedValue({ to: NETWORK.toUpperCase().replace("0X", "0x") });

    await expect(heldReportDelivery(hash(2))).resolves.toBe("network");
  });

  it("says unknown for any other address, so a stranger is never named", async () => {
    reads.getTransaction.mockResolvedValue({ to: `0x${"cd".repeat(20)}` });

    await expect(heldReportDelivery(hash(3))).resolves.toBe("unknown");
  });

  it("says unknown when the chain will not answer, and never throws", async () => {
    reads.getTransaction.mockRejectedValue(new Error("rpc is down"));

    await expect(heldReportDelivery(hash(4))).resolves.toBe("unknown");
  });

  it("says unknown for a contract creation, which carries no to address", async () => {
    reads.getTransaction.mockResolvedValue({ to: null });

    await expect(heldReportDelivery(hash(5))).resolves.toBe("unknown");
  });
});
