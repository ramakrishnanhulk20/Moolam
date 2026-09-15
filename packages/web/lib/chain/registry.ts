import type { Hex } from "viem";
import { chain, addresses, policyAbi, registryAbi } from "./client";
import type { PassportInput } from "./calldata";

export { getAgent, heldAgent } from "./agents";
export { getReputation, getReputationClients, heldReputation } from "./reputation";

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
 * One call, not two. The contract answers a id it never saw with a zeroed
 * struct, and registeredAt is the field that cannot be zero on a real record,
 * so the same read that fetches the passport also says whether it exists.
 * Null rather than a record of zeroes, because a page showing zeroes and a
 * page showing "no such passport" are two different answers.
 */
export async function getPassport(id: Hex): Promise<Passport | null> {
  const record = (await chain.readContract({
    address: addresses.registry,
    abi: registryAbi,
    functionName: "getPassport",
    args: [id],
  })) as Omit<Passport, "id">;

  return record.registeredAt === 0n ? null : { ...record, id };
}

/**
 * Every attestation on a passport, oldest first.
 *
 * The contract caps the list at 64 and clips a page to what exists, so asking
 * for 64 from the start is the whole list in one call and the count read that
 * used to come first buys nothing.
 */
export const ATTESTATION_CAP = 64n;

export async function getAttestations(id: Hex): Promise<Attestation[]> {
  return (await chain.readContract({
    address: addresses.registry,
    abi: registryAbi,
    functionName: "getAttestations",
    args: [id, 0n, ATTESTATION_CAP],
  })) as Attestation[];
}

/** How much of a child list one page holds. Long enough for any passport on the chain today. */
export const CHILD_PAGE_SIZE = 48;

export interface ChildPage {
  /** Newest first when the page was asked for that way, otherwise in the order the contract stores them. */
  items: Hex[];
  /** How many edits the passport has in total, however many this page holds. */
  total: number;
}

export interface ChildPageRequest {
  newestFirst: boolean;
  size: number;
}

/**
 * The passports registered as edits of this one.
 *
 * The child list has no cap on chain, because every edit is its own
 * transaction paid for by its own creator, so reading the whole list is a call
 * whose size a stranger decides. This reads one clipped page instead: the
 * count, then the last `size` entries of the list, which is the newest page.
 *
 * The no-page form is the old whole-list read and exists only while the edit
 * panel and the passport page still call it that way.
 *
 * @deprecated Pass a page. The whole-list form goes when those callers move.
 */
export async function getChildren(id: Hex): Promise<Hex[]>;
export async function getChildren(id: Hex, page: ChildPageRequest): Promise<ChildPage>;
export async function getChildren(id: Hex, page?: ChildPageRequest): Promise<Hex[] | ChildPage> {
  const count = (await chain.readContract({
    address: addresses.registry,
    abi: registryAbi,
    functionName: "childCount",
    args: [id],
  })) as bigint;

  if (page === undefined) {
    return count === 0n ? [] : await childPage(id, 0n, count);
  }

  const total = Number(count);
  const size = BigInt(Math.max(1, page.size));
  const offset = page.newestFirst && count > size ? count - size : 0n;
  if (count === 0n) {
    return { items: [], total };
  }

  const items = await childPage(id, offset, size);
  return { items: page.newestFirst ? [...items].reverse() : items, total };
}

async function childPage(id: Hex, offset: bigint, limit: bigint): Promise<Hex[]> {
  return (await chain.readContract({
    address: addresses.registry,
    abi: registryAbi,
    functionName: "getChildren",
    args: [id, offset, limit],
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
