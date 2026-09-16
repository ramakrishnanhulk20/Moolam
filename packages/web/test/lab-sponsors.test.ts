import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import {
  BLOCK_TIME_SPAN,
  ENTRY_POINT,
  bitsApart,
  bitsOf,
  blockMsAcross,
  feeInMon,
  isRead,
  phashWord,
  readChainlinkRecheck,
  readEnvioStanding,
  readMonadReceipt,
  readSponsoredRegistration,
  throughEntryPoint,
  type AttestationLog,
  type BenchSource,
  type RegistrationLog,
} from "@/lib/lab/sponsors";

/**
 * The sponsor bench reads the registry's own events, the transactions behind
 * them and the pinned titles. Every source is answered here in the network's
 * stead, so what is under test is the reading and not a live endpoint: that a
 * figure is measured rather than assumed, and that a source which says nothing
 * costs the panel its number instead of producing one.
 */

const REGISTRY_TX = `0x${"a1".repeat(32)}` as Hex;
const SPONSORED_TX = `0x${"b2".repeat(32)}` as Hex;
const REPORT_TX = `0x${"c3".repeat(32)}` as Hex;
const CREATOR = "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c" as Hex;
const BUNDLER = "0xb00439E6f77af558c79005EE9d158Df547490e88" as Hex;
const RECEIVER = "0x0d69055c43EAcb3B1ca687ca2263A049Bc7Eff04" as Hex;

const PHASH = 0x9c3d7e21f0a45b68n;

function registration(over: Partial<RegistrationLog> = {}): RegistrationLog {
  return {
    id: `0x${"1f".repeat(32)}` as Hex,
    creator: CREATOR,
    agentId: 10249n,
    phash: PHASH,
    metadataURI: "ipfs://bafkreiplain",
    block: 103_600_000n,
    txHash: REGISTRY_TX,
    ...over,
  };
}

function attestation(over: Partial<AttestationLog> = {}): AttestationLog {
  return {
    passportId: registration().id,
    receiver: RECEIVER,
    matched: true,
    distance: 0,
    recomputed: `0x${"0".repeat(48)}${PHASH.toString(16).padStart(16, "0")}` as Hex,
    block: 103_800_000n,
    txHash: REPORT_TX,
    ...over,
  };
}

/** Every source answered, with the parts a test cares about handed in. */
function source(over: Partial<BenchSource> = {}): BenchSource {
  return {
    registrations: async () => [registration()],
    attestations: async () => [attestation()],
    // A second every three blocks, so neighbouring blocks share one the way
    // Monad's do and the window is the only place a time difference shows up.
    block: async (number) => ({ number, timestamp: 1_789_000_000n + number / 3n }),
    transaction: async () => ({ to: "0xa19188801E5DC93CD925884d73e4DaFc2bcb80C0" as Hex }),
    receipt: async () => ({ gasUsed: 581_824n, effectiveGasPrice: 102_000_000_000n, from: CREATOR }),
    passkey: async () => true,
    document: async () => ({ title: "Monsoon Fishing Nets Drying", picture: "ipfs://bafkreipicture" }),
    indexBlock: async () => 105_252_623,
    head: async () => 105_253_829,
    ...over,
  };
}

describe("the two figures every panel is built on", () => {
  it("averages the block time across the window, in whole milliseconds", () => {
    const span = { number: 100n, timestamp: 1_000n };
    const block = { number: 350n, timestamp: 1_100n };
    expect(blockMsAcross(span, block)).toBe(400);
  });

  it("refuses a window that does not move forward, rather than dividing by zero", () => {
    expect(() => blockMsAcross({ number: 10n, timestamp: 5n }, { number: 10n, timestamp: 5n })).toThrow();
  });

  it("bills gas at the price the receipt actually paid", () => {
    expect(feeInMon(581_824n, 102_000_000_000n)).toBe("0.059346048");
  });
});

describe("the receipt panel", () => {
  it("measures the block time over the window rather than over one pair of blocks", async () => {
    const reading = await readMonadReceipt(source());
    expect(isRead(reading)).toBe(true);
    if (!isRead(reading)) return;

    expect(reading.read.blockMs).toBe(332);
    expect(reading.read.span.number).toBe(reading.read.block.number - BigInt(BLOCK_TIME_SPAN));
    expect(reading.read.sameSecond).toBe(true);
    expect(reading.read.feeMon).toBe("0.059346048");
  });

  it("keeps the panel when the receipt cannot be read, and shows no fee", async () => {
    const reading = await readMonadReceipt(
      source({
        receipt: async () => {
          throw new Error("the endpoint has no receipt for that hash");
        },
      }),
    );
    expect(isRead(reading) && reading.read.feeMon).toBeNull();
    expect(isRead(reading) && reading.read.gasUsed).toBeNull();
  });

  it("says why when the registry has emitted nothing", async () => {
    const reading = await readMonadReceipt(source({ registrations: async () => [] }));
    expect(reading).toEqual({ failed: "the registry has emitted no registration yet" });
  });
});

describe("the sponsored registration panel", () => {
  it("takes the newest transaction that went through the entry point", async () => {
    const rows = [registration({ txHash: REGISTRY_TX }), registration({ id: `0x${"2f".repeat(32)}` as Hex, txHash: SPONSORED_TX })];
    const reading = await readSponsoredRegistration(
      source({
        registrations: async () => rows,
        transaction: async (hash) => ({ to: hash === SPONSORED_TX ? ENTRY_POINT : (CREATOR as Hex) }),
        receipt: async () => ({ gasUsed: 581_824n, effectiveGasPrice: 102_000_000_000n, from: BUNDLER }),
      }),
    );

    expect(isRead(reading)).toBe(true);
    if (!isRead(reading)) return;
    expect(reading.read.txHash).toBe(SPONSORED_TX);
    expect(reading.read.sender).toBe(BUNDLER);
    expect(reading.read.feeMon).toBe("0.059346048");
    expect(reading.read.scanned).toBe(2);
    expect(reading.read.passkey).toBe(true);
  });

  it("matches the entry point whatever case the endpoint answers in", () => {
    expect(throughEntryPoint(ENTRY_POINT.toLowerCase() as Hex)).toBe(true);
    expect(throughEntryPoint(CREATOR)).toBe(false);
    expect(throughEntryPoint(null)).toBe(false);
  });

  it("says so rather than picking one when nothing in the scan was sponsored", async () => {
    const reading = await readSponsoredRegistration(source(), 1);
    expect(isRead(reading)).toBe(false);
    if (isRead(reading)) return;
    expect(reading.failed).toContain("none of the newest 1 registrations");
  });
});

describe("the re-check panel", () => {
  it("finds the picture by its pinned title and counts the bits itself", async () => {
    const reading = await readChainlinkRecheck(source());
    expect(isRead(reading)).toBe(true);
    if (!isRead(reading)) return;

    expect(reading.read.title).toBe("Monsoon Fishing Nets Drying");
    expect(reading.read.recomputed).toBe(PHASH);
    expect(reading.read.distance).toBe(0);
    expect(reading.read.counted).toBe(0);
    expect(reading.read.chainlink).toBe(true);
    expect(reading.read.reportTx).toBe(REPORT_TX);
  });

  it("counts the bits off the two fingerprints rather than trusting the written distance", async () => {
    const drifted = (PHASH ^ 0b1011n) as bigint;
    const reading = await readChainlinkRecheck(
      source({
        attestations: async () => [
          attestation({
            distance: 0,
            recomputed: `0x${"0".repeat(48)}${drifted.toString(16).padStart(16, "0")}` as Hex,
          }),
        ],
      }),
    );

    expect(isRead(reading) && reading.read.counted).toBe(3);
    expect(isRead(reading) && reading.read.distance).toBe(0);
  });

  it("says which title it could not find rather than showing another picture", async () => {
    const reading = await readChainlinkRecheck(source({ document: async () => ({ title: "Something else", picture: null }) }));
    expect(isRead(reading)).toBe(false);
    if (isRead(reading)) return;
    expect(reading.failed).toContain("Monsoon Fishing Nets Drying");
  });

  it("reads the fingerprint out of the padded word, and leaves an unpadded one whole", () => {
    expect(phashWord(`0x${"0".repeat(48)}9c3d7e21f0a45b68` as Hex)).toBe(PHASH);
    const full = `0x${"ab".repeat(32)}` as Hex;
    expect(phashWord(full)).toBe(BigInt(full));
  });

  it("draws 64 bits, highest first, and counts how many differ", () => {
    const bits = bitsOf(PHASH);
    expect(bits).toHaveLength(64);
    expect(bits[0]).toBe(true);
    expect(bits[1]).toBe(false);
    expect(bitsApart(PHASH, PHASH)).toBe(0);
    expect(bitsApart(PHASH, PHASH ^ 0b111n)).toBe(3);
  });
});

describe("the index panel", () => {
  it("reads the lag in blocks, and marks that no seen-time exists", async () => {
    const reading = await readEnvioStanding(source());
    expect(isRead(reading)).toBe(true);
    if (!isRead(reading)) return;

    expect(reading.read.behind).toBe(1_206);
    expect(reading.read.noSeenTime).toBe(true);
    expect(reading.read.sinceNewest).toBe(105_252_623 - 103_600_000);
  });

  it("never reports a negative lag when the index runs ahead of a stale head", async () => {
    const reading = await readEnvioStanding(source({ head: async () => 105_252_000 }));
    expect(isRead(reading) && reading.read.behind).toBe(0);
  });

  it("shows no number at all when the index will not answer", async () => {
    const reading = await readEnvioStanding(source({ indexBlock: async () => null }));
    expect(reading).toEqual({ failed: "the index did not answer with a processed block" });
  });
});
