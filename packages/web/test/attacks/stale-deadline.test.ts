// Attack 2 of the second attack pass: a laptop whose clock is 61 minutes slow stamps a deadline
// the registry has already passed, and the passkey signs a window that was dead before it opened.
// The head block is stubbed and the machine clock is a fake one, so the two can be put 61 minutes
// apart on purpose. Nothing is sent.
// Does NOT cover the registry refusing such a deadline. That half is executed against a fork of
// Monad mainnet by packages/agents/scripts/attack-pass-2.ts, attack 2b, which shows
// SignatureExpired.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { SIGNATURE_WINDOW_SECONDS, passportInputFrom } from "@/lib/chain/calldata";
import { deadlineFromChain } from "@/lib/chain/time";

const reads = vi.hoisted(() => ({ getBlock: vi.fn() }));

vi.mock("@/lib/chain/client", () => ({ chain: { getBlock: reads.getBlock } }));

/** What the chain's own head block says the time is. */
const CHAIN_NOW = 1_788_876_542n;

/** How far behind the chain this machine's clock runs. */
const SLOW_BY = 61n * 60n;

const PREPARED = {
  exactHash: `0x${"ab".repeat(32)}` as Hex,
  parentId: `0x${"00".repeat(32)}` as Hex,
  generatorAgentId: "0",
  phash: "17297841240124424192",
  blockhash256: `0x${"cd".repeat(32)}` as Hex,
  manifestHash: `0x${"00".repeat(32)}` as Hex,
  kind: 0,
  fingerprintVersion: 1,
  metadataURI: "ipfs://bafkreimine",
};

const CREATOR = "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c" as Hex;

// The machine clock is pinned 61 minutes behind the chain for every test in this file. Each one
// reads the same head block, so the hold inside lib/chain/time cannot change an answer here.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Number(CHAIN_NOW - SLOW_BY) * 1000);
  reads.getBlock.mockReset().mockResolvedValue({ timestamp: CHAIN_NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a deadline stamped from a clock 61 minutes slow", () => {
  it("still lands in the future when it is measured from the chain's own head block", async () => {
    const deadline = await deadlineFromChain(SIGNATURE_WINDOW_SECONDS);

    expect(deadline).toBe(CHAIN_NOW + SIGNATURE_WINDOW_SECONDS);
    expect(deadline).toBeGreaterThan(CHAIN_NOW);
  });

  it("would already be spent if it came from this machine's clock", () => {
    const fromBrowser = passportInputFrom(PREPARED, CREATOR).deadline;

    expect(fromBrowser).toBeLessThan(CHAIN_NOW);
    expect(CHAIN_NOW - fromBrowser).toBeGreaterThan(1_800n);
  });

  it("puts the two answers a full slow hour apart, which is the whole attack", async () => {
    const fromChain = await deadlineFromChain(SIGNATURE_WINDOW_SECONDS);
    const fromBrowser = passportInputFrom(PREPARED, CREATOR).deadline;

    expect(fromChain - fromBrowser).toBeGreaterThanOrEqual(SLOW_BY - 5n);
    expect(fromChain - fromBrowser).toBeLessThanOrEqual(SLOW_BY + 5n);
  });
});
