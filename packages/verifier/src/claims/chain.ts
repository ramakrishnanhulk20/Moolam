import type { Address, Hex } from "viem";
import { env } from "../env.js";
import { liveChain, type ChainPassport } from "../platform/chain.js";
import { readClient } from "../reputation/registry.js";
import { holderOf } from "../unseal.js";

/**
 * The three chain reads the claim flow rests on (P27): chain time, the registry's record of a
 * passport, and who holds it. Each is read at the moment it is asked, and every caller treats a
 * throw as "the chain could not say", so nothing changes on a read that failed.
 */
export interface ClaimChain {
  now: () => Promise<bigint>;
  /** The passport the registry holds for this id, or undefined when it holds none. */
  passport: (passportId: Hex) => Promise<ChainPassport | undefined>;
  /** ownerOf(passportId) on the registry, checksummed. Throws for an id with no token and for any RPC failure. */
  ownerOf: (passportId: Hex) => Promise<Address>;
}

/** The live reads, through the platform routes' own reads and the unseal route's holder read. */
export function liveClaimChain(): ClaimChain {
  const platform = liveChain();
  const client = readClient();
  const registry = env.MOOLAM_REGISTRY_ADDRESS as Hex;
  return {
    now: platform.now,
    passport: platform.passport,
    ownerOf: async (passportId) => await holderOf(client, registry, passportId),
  };
}

/**
 * A chain that cannot be read, for a host under a test runner: no unit suite may depend on a public
 * RPC, and every claim step fails closed on it. A test that wants the chain passes its own.
 */
export function offlineClaimChain(): ClaimChain {
  const refuse = async (): Promise<never> => {
    throw new Error("no chain under a test runner");
  };
  return { now: refuse, passport: refuse, ownerOf: refuse };
}
