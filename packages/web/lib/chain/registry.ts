import type { Hex } from "viem";
import { chain, addresses, policyAbi, registryAbi } from "./client";
import type { PassportInput } from "./calldata";

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

/** The passkey bound to a wallet, as the registry stores it. */
export interface Passkey {
  qx: Hex;
  qy: Hex;
}

/** A challenge against a passport and the bond behind it. */
export interface Dispute {
  challenger: Hex;
  bond: bigint;
  evidenceHash: Hex;
  status: number;
  openedAt: bigint;
}

/** DisputeStatus in IMoolamRegistry.sol. None is what an unchallenged passport reads back. */
export const DisputeStatus = { None: 0, Open: 1, Upheld: 2, Rejected: 3 } as const;

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

/**
 * The passkey bound to a wallet, or null when there is none.
 *
 * The contract answers with two zero words for a wallet that never bound one,
 * and "no passkey yet" is the studio's first fork in the road, so it is worth
 * saying plainly rather than handing back zeroes.
 */
export async function getPasskey(wallet: Hex): Promise<Passkey | null> {
  const [qx, qy] = (await chain.readContract({
    address: addresses.registry,
    abi: registryAbi,
    functionName: "getPasskey",
    args: [wallet],
  })) as readonly [Hex, Hex];

  return qx === ZERO_ID && qy === ZERO_ID ? null : { qx, qy };
}

/** The nonce the next bind signature has to carry. It goes up by one on every bind. */
export async function bindNonce(wallet: Hex): Promise<bigint> {
  return (await chain.readContract({
    address: addresses.registry,
    abi: registryAbi,
    functionName: "bindNonce",
    args: [wallet],
  })) as bigint;
}

/**
 * The digest a passkey signs to bind itself to a wallet.
 *
 * It is read from the contract rather than rebuilt in the browser, so the
 * EIP-712 domain, the type string and the chain id can never drift from what
 * the deployed registry will check.
 */
export async function hashBind(wallet: Hex, qx: Hex, qy: Hex, nonce: bigint): Promise<Hex> {
  return (await chain.readContract({
    address: addresses.registry,
    abi: registryAbi,
    functionName: "hashBind",
    args: [wallet, qx, qy, nonce],
  })) as Hex;
}

/** The digest a creator's passkey signs to register a passport, read from the contract itself. */
export async function hashPassport(input: PassportInput): Promise<Hex> {
  return (await chain.readContract({
    address: addresses.registry,
    abi: registryAbi,
    functionName: "hashPassport",
    args: [input],
  })) as Hex;
}

/** The dispute on a passport, or null when nobody has challenged it. */
export async function getDispute(id: Hex): Promise<Dispute | null> {
  const dispute = (await chain.readContract({
    address: addresses.registry,
    abi: registryAbi,
    functionName: "getDispute",
    args: [id],
  })) as Dispute;

  return dispute.status === DisputeStatus.None ? null : dispute;
}

/**
 * What the policy demands behind a flag, in wei.
 *
 * Read live rather than written into the app: the owner can change it through
 * the policy's 24 hour timelock, and a page that promised yesterday's number
 * would send a transaction the registry refuses.
 */
export async function disputeBond(): Promise<bigint> {
  return (await chain.readContract({
    address: addresses.policy,
    abi: policyAbi,
    functionName: "disputeBond",
  })) as bigint;
}

/** The one address the policy lets settle disputes. */
export async function resolver(): Promise<Hex> {
  return (await chain.readContract({
    address: addresses.policy,
    abi: policyAbi,
    functionName: "resolver",
  })) as Hex;
}

/** Where a rejected challenger's bond is credited. */
export async function treasury(): Promise<Hex> {
  return (await chain.readContract({
    address: addresses.policy,
    abi: policyAbi,
    functionName: "treasury",
  })) as Hex;
}

/**
 * What the registry owes this address and has not paid out, in wei.
 *
 * Money here is pulled and never pushed, so this is the number behind the
 * withdraw button. It is zero for almost everybody.
 */
export async function withdrawable(who: Hex): Promise<bigint> {
  return (await chain.readContract({
    address: addresses.registry,
    abi: registryAbi,
    functionName: "withdrawable",
    args: [who],
  })) as bigint;
}
