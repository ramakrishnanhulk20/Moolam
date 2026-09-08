import type { Hex } from "viem";
import { chain, addresses, registryAbi } from "./client";

export { getAgent } from "./agents";
export { getReputation, getReputationClients } from "./reputation";

/** One registered image, exactly as the contract stores it. */
export interface Passport {
  id: Hex;
  exactHash: Hex;
  parentId: Hex;
  creator: Hex;
  generatorAgentId: bigint;
  phash: bigint;
  blockhash256: Hex;
  manifestHash: Hex;
  kind: number;
  fingerprintVersion: number;
  registeredAt: bigint;
  disputed: boolean;
  metadataURI: string;
}

/** One independent re-check written back by a verifier the policy allows. */
export interface Attestation {
  receiver: Hex;
  matched: boolean;
  distance: number;
  recomputed: Hex;
  at: bigint;
}

export const ZERO_ID = "0x0000000000000000000000000000000000000000000000000000000000000000";

/**
 * Reads one passport.
 *
 * Returns null for an id that was never registered rather than an empty record,
 * because a page showing zeroes and a page showing "no such passport" are two
 * different answers.
 */
export async function getPassport(id: Hex): Promise<Passport | null> {
  const exists = (await chain.readContract({
    address: addresses.registry,
    abi: registryAbi,
    functionName: "passportExists",
    args: [id],
  })) as boolean;

  if (!exists) {
    return null;
  }

  const record = (await chain.readContract({
    address: addresses.registry,
    abi: registryAbi,
    functionName: "getPassport",
    args: [id],
  })) as Omit<Passport, "id">;

  return { ...record, id };
}

/** Every attestation on a passport. The contract caps the list at 64. */
export async function getAttestations(id: Hex): Promise<Attestation[]> {
  const count = (await chain.readContract({
    address: addresses.registry,
    abi: registryAbi,
    functionName: "attestationCount",
    args: [id],
  })) as bigint;

  if (count === 0n) {
    return [];
  }

  return (await chain.readContract({
    address: addresses.registry,
    abi: registryAbi,
    functionName: "getAttestations",
    args: [id, 0n, count],
  })) as Attestation[];
}

/** The passports registered as edits of this one, oldest first. */
export async function getChildren(id: Hex): Promise<Hex[]> {
  const count = (await chain.readContract({
    address: addresses.registry,
    abi: registryAbi,
    functionName: "childCount",
    args: [id],
  })) as bigint;

  if (count === 0n) {
    return [];
  }

  return (await chain.readContract({
    address: addresses.registry,
    abi: registryAbi,
    functionName: "getChildren",
    args: [id, 0n, count],
  })) as Hex[];
}

/**
 * Who holds the passport now.
 *
 * The passport id is also the ERC-721 token id, and ownerOf reverts for a token
 * that does not exist, which is why the revert is turned into null here.
 */
export async function getOwner(id: Hex): Promise<Hex | null> {
  try {
    return (await chain.readContract({
      address: addresses.registry,
      abi: registryAbi,
      functionName: "ownerOf",
      args: [BigInt(id)],
    })) as Hex;
  } catch {
    return null;
  }
}
