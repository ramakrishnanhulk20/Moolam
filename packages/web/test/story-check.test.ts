import type { Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IndexedAttestation } from "@/components/passport/indexed";

/**
 * The film's checked beat plays in the network form only on the network's own
 * word. Where the index serves the flag, the flag decides the same way the
 * passport page's mark reads it; the forwarder that carried the report is asked
 * only where the index serves none, and when the flag says false it can only
 * tell a test run from any other write, never promote the verdict.
 *
 * Both reads are stubs. What this does NOT cover is the index's and the
 * chain's real answers; test/marks.test.ts walks the same rule on the mark.
 */

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => Promise<unknown>) => fn,
}));

const reads = vi.hoisted(() => ({ rows: vi.fn(), delivery: vi.fn() }));

vi.mock("@/components/passport/indexed", async (original) => ({
  ...(await original<typeof import("@/components/passport/indexed")>()),
  heldIndexedVerdictRows: reads.rows,
}));
vi.mock("@/lib/chain/reports", () => ({ heldReportDelivery: reads.delivery }));

const { focalCheck } = await import("@/components/story/data");

const PASSPORT = `0x${"7c".repeat(32)}` as Hex;
const RECEIVER = "0x1111111111111111111111111111111111111111" as Hex;
const TX = `0x${"aa".repeat(32)}` as Hex;
const AT = 1_790_000_600;

const attestation = { passportId: PASSPORT, matched: true, distance: 0, receiver: RECEIVER, at: AT };

function row(network?: boolean): IndexedAttestation {
  return {
    txHash: TX,
    receiver: RECEIVER,
    matched: true,
    distance: 0,
    at: BigInt(AT),
    ...(network === undefined ? {} : { network }),
  };
}

beforeEach(() => {
  reads.rows.mockResolvedValue([row()]);
  reads.delivery.mockResolvedValue("unknown");
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("the film's focal check", () => {
  it("plays the network form on the index's flag, without asking the forwarder", async () => {
    reads.rows.mockResolvedValue([row(true)]);
    expect((await focalCheck(attestation)).form).toBe("network");
    expect(reads.delivery).not.toHaveBeenCalled();
  });

  it("never plays the network form when the index says false, whatever the forwarder says", async () => {
    reads.rows.mockResolvedValue([row(false)]);
    reads.delivery.mockResolvedValue("network");
    expect((await focalCheck(attestation)).form).toBe("plain");
  });

  it("lets the forwarder tell a test run from a plain write when the index says false", async () => {
    reads.rows.mockResolvedValue([row(false)]);
    reads.delivery.mockResolvedValue("simulation");
    expect((await focalCheck(attestation)).form).toBe("test");
    reads.delivery.mockResolvedValue("unknown");
    expect((await focalCheck(attestation)).form).toBe("plain");
  });

  it("asks the forwarder only where the index serves no flag", async () => {
    reads.delivery.mockResolvedValue("network");
    expect((await focalCheck(attestation)).form).toBe("network");
    reads.delivery.mockResolvedValue("simulation");
    expect((await focalCheck(attestation)).form).toBe("test");
    reads.delivery.mockResolvedValue("unknown");
    expect((await focalCheck(attestation)).form).toBe("plain");
  });

  it("plays the plain form when the rows cannot be read or the transaction cannot be found", async () => {
    reads.rows.mockRejectedValue(new Error("index down"));
    expect((await focalCheck(attestation)).form).toBe("plain");
    reads.rows.mockResolvedValue([{ ...row(), distance: 9 }]);
    expect((await focalCheck(attestation)).form).toBe("plain");
  });
});
