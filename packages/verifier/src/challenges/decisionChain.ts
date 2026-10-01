import { getAddress, type Address, type Hex } from "viem";
import { disputeAbi } from "../disputeRead.js";
import { env } from "../env.js";
import { readClient } from "../reputation/registry.js";

/**
 * MoolamDecisions on Monad mainnet, deployed by packages/contracts/script/DeployLookalikes.s.sol
 * (broadcast/DeployLookalikes.s.sol/143/run-latest.json). The container ships only this package's
 * source, so the address is held here, as the registry's and the consent contract's are in env.ts.
 */
export const MOOLAM_DECISIONS = "0x30AbA7747342fA3ac9d990Ec2Cf407cC968c497F" as Hex;

/** The registry's DisputeStatus enum values a settled dispute can hold. */
export const DISPUTE_UPHELD = 2;
export const DISPUTE_REJECTED = 3;

const decisionsAbi = [
  { type: "function", name: "REGISTRY", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "POLICY", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  {
    type: "function",
    name: "published",
    stateMutability: "view",
    inputs: [
      { name: "passportId", type: "bytes32" },
      { name: "openedAt", type: "uint64" },
    ],
    outputs: [{ name: "done", type: "bool" }],
  },
] as const;

const policyAbi = [
  { type: "function", name: "resolver", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
] as const;

/** One decision's facts, read at one block, with that block's time. */
export interface DecisionAtBlock {
  /** The block's timestamp in unix seconds: the chain time the deadline is judged against. */
  now: bigint;
  /** The resolver named by the policy MoolamDecisions reads, at that block. */
  resolver: Address;
  /** getDispute(passportId) at that block. */
  dispute: { status: number; openedAt: bigint };
  /** MoolamDecisions.published(passportId, openedAt) at that block, for the openedAt asked about. */
  published: boolean;
}

/**
 * The one chain read the reasons route makes. Every field comes from the same block, so the
 * resolver, the dispute, whether it is published and the time are never from two moments (L28).
 * Throws when the chain cannot be read, and when MoolamDecisions is bound to another registry than
 * the one this service signs against; the route answers 503 and pins nothing.
 */
export interface DecisionChain {
  decisionAt: (passportId: Hex, openedAt: bigint) => Promise<DecisionAtBlock>;
}

/** The live read, through the service's one Monad transport. */
export function liveDecisionChain(decisions: Hex = MOOLAM_DECISIONS): DecisionChain {
  const client = readClient();
  const registry = getAddress(env.MOOLAM_REGISTRY_ADDRESS);
  return {
    decisionAt: async (passportId, openedAt) => {
      const block = await client.getBlock({ blockTag: "latest" });
      const blockNumber = block.number;
      const [boundRegistry, policy, dispute, published] = await Promise.all([
        client.readContract({ address: decisions, abi: decisionsAbi, functionName: "REGISTRY", blockNumber }),
        client.readContract({ address: decisions, abi: decisionsAbi, functionName: "POLICY", blockNumber }),
        client.readContract({ address: registry, abi: disputeAbi, functionName: "getDispute", args: [passportId], blockNumber }),
        client.readContract({ address: decisions, abi: decisionsAbi, functionName: "published", args: [passportId, openedAt], blockNumber }),
      ]);
      if (getAddress(boundRegistry) !== registry) {
        throw new Error("MoolamDecisions explains another registry than the one this service signs against");
      }
      // MoolamDecisions.publish reads the resolver from this very policy, so this is the one that can publish.
      const resolver = await client.readContract({ address: getAddress(policy), abi: policyAbi, functionName: "resolver", blockNumber });
      return {
        now: block.timestamp,
        resolver: getAddress(resolver),
        dispute: { status: Number(dispute.status), openedAt: dispute.openedAt },
        published,
      };
    },
  };
}

/** A chain that cannot be read, for a host under a test runner: the route answers 503 on it. */
export function offlineDecisionChain(): DecisionChain {
  return {
    decisionAt: async () => {
      throw new Error("no chain under a test runner");
    },
  };
}
