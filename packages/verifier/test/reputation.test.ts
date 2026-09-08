// Covers the reputation writer: the score math, the summary document behind
// feedbackHash, the eight arguments giveFeedback is called with, and the
// getSummary read. The chain is a fake transport that answers the JSON-RPC
// calls viem makes, so the encoding and decoding are real and the network is not.
// Does NOT cover the deployed registry's own rules. That it refuses the agent's
// owner, and that it needs a non-empty client list, was proven with live eth_call
// simulations recorded in kitchen/reports/WO-6a-reputation.txt, not here.

import { describe, expect, it } from "vitest";
import {
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  keccak256,
  parseTransaction,
  stringToHex,
  toHex,
  type Hex as ViemHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { postFeedback, readReputation, scoreFor, verificationSummary } from "../src/reputation/feedback.js";
import { REPUTATION_REGISTRY, reputationAbi } from "../src/reputation/registry.js";
import type { Hex } from "../src/types.js";

// Anvil's second account, printed by Foundry on every start. It holds nothing
// and signs nothing outside this file.
const SIGNER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const SIGNER = privateKeyToAccount(SIGNER_KEY).address.toLowerCase();
const PASSPORT = "0x59bdee9f4478fcb4bab722ca2224bac05350ed3d1d0397a81c998a2b0ad24440" as Hex;
const METADATA_URI = "ipfs://bafkreifsrqzdwddo2b4f2337lgybebksbwcm5ovpeagc34wom2vmfqvtdu";
const GAS_ESTIMATE = 297_061n;

interface Sent {
  to: string;
  data: ViemHex;
  gas: bigint;
}

/** A chain that answers every call viem makes, records the signed transaction, and confirms it. */
function fakeChain(options: { summary?: [bigint, bigint, number]; estimateReverts?: string } = {}): {
  transport: ReturnType<typeof custom>;
  sent: Sent[];
  calls: { method: string; params: unknown }[];
} {
  const sent: Sent[] = [];
  const calls: { method: string; params: unknown }[] = [];
  const txHash = keccak256(stringToHex("moolam-test-transaction"));

  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      calls.push({ method, params });
      switch (method) {
        case "eth_chainId":
          return toHex(143);
        case "eth_getTransactionCount":
          return toHex(7);
        case "eth_maxPriorityFeePerGas":
          return toHex(1_000_000_000n);
        case "eth_gasPrice":
          return toHex(60_000_000_000n);
        case "eth_getBlockByNumber":
          return {
            number: toHex(102_990_000n),
            hash: keccak256(stringToHex("block")),
            baseFeePerGas: toHex(50_000_000_000n),
            timestamp: toHex(1_788_855_232n),
            transactions: [],
          };
        case "eth_estimateGas":
          if (options.estimateReverts !== undefined) {
            throw new Error(`execution reverted: ${options.estimateReverts}`);
          }
          return toHex(GAS_ESTIMATE);
        case "eth_sendRawTransaction": {
          const raw = (params as ViemHex[])[0] as ViemHex;
          const parsed = parseTransaction(raw);
          sent.push({ to: parsed.to ?? "", data: parsed.data ?? "0x", gas: parsed.gas ?? 0n });
          return txHash;
        }
        case "eth_getTransactionReceipt":
          return {
            transactionHash: txHash,
            transactionIndex: toHex(0),
            blockHash: keccak256(stringToHex("block")),
            blockNumber: toHex(102_990_001n),
            from: SIGNER,
            to: REPUTATION_REGISTRY,
            cumulativeGasUsed: toHex(290_000n),
            gasUsed: toHex(285_431n),
            effectiveGasPrice: toHex(51_000_000_000n),
            contractAddress: null,
            logs: [],
            logsBloom: `0x${"0".repeat(512)}`,
            status: "0x1",
            type: "0x2",
          };
        case "eth_call": {
          const [count, value, decimals] = options.summary ?? [0n, 0n, 0];
          return encodeAbiParameters(
            [{ type: "uint64" }, { type: "int128" }, { type: "uint8" }],
            [count, value, decimals],
          );
        }
        default:
          throw new Error(`the fake chain was asked for ${method}, which the test does not expect`);
      }
    },
  });

  return { transport, sent, calls };
}

describe("scoreFor", () => {
  it("runs from 100 at an exact fingerprint down to 9 at the matching threshold", () => {
    expect(scoreFor(true, 0)).toBe(100);
    expect(scoreFor(true, 5)).toBe(55);
    expect(scoreFor(true, 10)).toBe(9);
  });

  it("never goes below zero, and a mismatch scores zero at any distance", () => {
    expect(scoreFor(true, 64)).toBe(0);
    expect(scoreFor(false, 0)).toBe(0);
    expect(scoreFor(false, 10)).toBe(0);
  });

  it("refuses a distance that is not a whole number of bits in range", () => {
    expect(() => scoreFor(true, -1)).toThrow(/between 0 and 64/);
    expect(() => scoreFor(true, 65)).toThrow(/between 0 and 64/);
    expect(() => scoreFor(true, 1.5)).toThrow(/between 0 and 64/);
  });
});

describe("verificationSummary", () => {
  it("hashes the exact JSON it returns, and hashes the same verification the same way twice", () => {
    const first = verificationSummary({ agentId: 10_248n, passportId: PASSPORT, matched: true, distance: 1 });
    const second = verificationSummary({ agentId: 10_248n, passportId: PASSPORT, matched: true, distance: 1 });

    expect(first.hash).toBe(keccak256(stringToHex(first.json)));
    expect(second.hash).toBe(first.hash);
    expect(JSON.parse(first.json)).toEqual({
      product: "moolam",
      check: "verification",
      agentId: "10248",
      passportId: PASSPORT,
      matched: true,
      distanceBits: 1,
      score: 91,
    });
  });
});

describe("postFeedback", () => {
  it("calls giveFeedback with the eight arguments the deployment takes", async () => {
    const chain = fakeChain();
    const result = await postFeedback({
      agentId: 10_248n,
      matched: true,
      distance: 1,
      passportId: PASSPORT,
      metadataURI: METADATA_URI,
      endpoint: "https://verify.moolam.xyz",
      signerKey: SIGNER_KEY,
      transport: chain.transport,
    });

    expect(chain.sent).toHaveLength(1);
    const call = chain.sent[0];
    expect(call?.to.toLowerCase()).toBe(REPUTATION_REGISTRY.toLowerCase());
    expect(call?.data.slice(0, 10)).toBe("0x3c036a7e");

    const decoded = decodeFunctionData({ abi: reputationAbi, data: call?.data ?? "0x" });
    expect(decoded.functionName).toBe("giveFeedback");
    expect(decoded.args).toEqual([
      10_248n,
      91n,
      0,
      "moolam",
      "verification",
      "https://verify.moolam.xyz",
      METADATA_URI,
      result.feedbackHash,
    ]);
    expect(result.score).toBe(91);
    expect(result.signer.toLowerCase()).toBe(SIGNER);
    expect(result.gasUsed).toBe(285_431n);
  });

  it("sets the gas limit to the estimate plus 5 percent, because Monad bills the limit", async () => {
    const chain = fakeChain();
    const result = await postFeedback({
      agentId: 10_248n,
      matched: false,
      distance: 30,
      passportId: PASSPORT,
      metadataURI: METADATA_URI,
      signerKey: SIGNER_KEY,
      transport: chain.transport,
    });

    expect(result.gasLimit).toBe((GAS_ESTIMATE * 105n) / 100n);
    expect(chain.sent[0]?.gas).toBe(result.gasLimit);
    expect(result.score).toBe(0);
  });

  it("refuses input that would write a meaningless entry, before it signs anything", async () => {
    const chain = fakeChain();
    const base = {
      agentId: 10_248n,
      matched: true,
      distance: 1,
      passportId: PASSPORT,
      metadataURI: METADATA_URI,
      signerKey: SIGNER_KEY,
      transport: chain.transport,
    };

    await expect(postFeedback({ ...base, agentId: 0n })).rejects.toThrow(/agentId/);
    await expect(postFeedback({ ...base, passportId: "0x1234" as Hex })).rejects.toThrow(/passportId/);
    await expect(postFeedback({ ...base, metadataURI: "  " })).rejects.toThrow(/metadataURI/);
    await expect(postFeedback({ ...base, distance: 70 })).rejects.toThrow(/between 0 and 64/);
    expect(chain.sent).toHaveLength(0);
  });

  it("broadcasts nothing when the chain rejects the call at gas estimation", async () => {
    // The registry refuses feedback from the agent's own owner. That refusal
    // arrives as a revert on the estimate, which runs before anything is
    // signed, so a self-rating never reaches the mempool.
    const chain = fakeChain({ estimateReverts: "Self-feedback not allowed" });

    await expect(
      postFeedback({
        agentId: 10_248n,
        matched: true,
        distance: 1,
        passportId: PASSPORT,
        metadataURI: METADATA_URI,
        signerKey: SIGNER_KEY,
        transport: chain.transport,
      }),
    ).rejects.toThrow(/Self-feedback not allowed/);

    expect(chain.sent).toHaveLength(0);
    expect(chain.calls.some((entry) => entry.method === "eth_sendRawTransaction")).toBe(false);
  });
});

describe("readReputation", () => {
  it("reads the summary for one client and both Moolam tags", async () => {
    const chain = fakeChain({ summary: [1n, 90n, 0] });
    const client = "0xC5ead1E4E5C6d56E87e02317f3fB3731cB0b6Ef7" as Hex;

    const summary = await readReputation(10_248n, { clients: [client], transport: chain.transport });

    expect(summary).toEqual({ count: 1n, value: 90n, decimals: 0 });
    const call = chain.calls.find((entry) => entry.method === "eth_call");
    const request = (call?.params as { to: string; data: ViemHex }[])[0];
    const decoded = decodeFunctionData({ abi: reputationAbi, data: request?.data ?? "0x" });
    expect(decoded.functionName).toBe("getSummary");
    expect(decoded.args).toEqual([10_248n, [client], "moolam", "verification"]);
  });

  it("refuses an empty client list, which the registry itself reverts on", async () => {
    const chain = fakeChain();
    await expect(readReputation(10_248n, { clients: [], transport: chain.transport })).rejects.toThrow(
      /at least one client address/,
    );
  });
});
