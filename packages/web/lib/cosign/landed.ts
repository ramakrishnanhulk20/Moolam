import { getAbiItem, pad, toEventSelector, type AbiEvent, type Hex } from "viem";
import { addresses, chain, consentAbi, registryAbi } from "@/lib/chain/client";

/**
 * P13: status is a chain read. "Registered" is said only after a receipt with
 * status 1 that holds PassportRegistered for this exact hash, and "terms
 * written" only after a receipt that holds ConsentSet for this passport from
 * this wallet. A passport that the registry simply holds is not enough on its
 * own: somebody else's transaction could have written it.
 */

const REGISTERED_EVENT = getAbiItem({ abi: registryAbi, name: "PassportRegistered" }) as AbiEvent;
const CONSENT_SET_EVENT = getAbiItem({ abi: consentAbi, name: "ConsentSet" }) as AbiEvent;

export const PASSPORT_REGISTERED_TOPIC = toEventSelector(REGISTERED_EVENT);
export const CONSENT_SET_TOPIC = toEventSelector(CONSENT_SET_EVENT);

/** The parts of a receipt these checks read. */
export interface ReceiptLike {
  status: "success" | "reverted";
  transactionHash: Hex;
  logs: readonly { address: string; topics: readonly (Hex | null | undefined)[] }[];
}

function same(a: string | null | undefined, b: string): boolean {
  return typeof a === "string" && a.toLowerCase() === b.toLowerCase();
}

/** A successful receipt carrying the registry's PassportRegistered for this passport id. */
export function holdsRegistration(receipt: ReceiptLike, exactHash: Hex, registry: Hex = addresses.registry): boolean {
  return (
    receipt.status === "success" &&
    receipt.logs.some(
      (log) =>
        same(log.address, registry) && same(log.topics[0], PASSPORT_REGISTERED_TOPIC) && same(log.topics[1], exactHash),
    )
  );
}

/** A successful receipt carrying the consent register's ConsentSet for this passport, written by this wallet. */
export function holdsConsentSet(
  receipt: ReceiptLike,
  passportId: Hex,
  writer: Hex,
  register: Hex = addresses.consent,
): boolean {
  const writerTopic = pad(writer.toLowerCase() as Hex, { size: 32 });
  return (
    receipt.status === "success" &&
    receipt.logs.some(
      (log) =>
        same(log.address, register) &&
        same(log.topics[0], CONSENT_SET_TOPIC) &&
        same(log.topics[1], passportId) &&
        same(log.topics[2], writerTopic),
    )
  );
}

/** How far back a log search for a fresh registration reaches: a wide window first, then short ones. */
const WIDE_SPAN = 5_000n;
const SHORT_SPAN = 100n;
const SHORT_WINDOWS = 20n;

/**
 * The hash of the newest transaction that emitted this event with these
 * indexed values, for a send whose wallet answered without a usable hash. Only
 * the last few thousand blocks are searched, which is minutes on Monad: this
 * runs right after a send, or on a page reopened soon after one.
 */
async function recentLogHash(address: Hex, event: AbiEvent, args: Record<string, Hex>): Promise<Hex | null> {
  const head = await chain.getBlockNumber();
  const ask = (fromBlock: bigint, toBlock: bigint) =>
    chain.getLogs({ address, event, args, fromBlock: fromBlock < 0n ? 0n : fromBlock, toBlock });

  try {
    const logs = await ask(head - WIDE_SPAN, head);
    return logs.at(-1)?.transactionHash ?? null;
  } catch {
    // Some endpoints cap the range of one query, so the same window is walked in short steps.
  }
  for (let step = 0n; step < SHORT_WINDOWS; step += 1n) {
    const toBlock = head - step * SHORT_SPAN;
    const logs = await ask(toBlock - SHORT_SPAN + 1n, toBlock);
    const found = logs.at(-1)?.transactionHash;
    if (found !== undefined && found !== null) {
      return found;
    }
  }
  return null;
}

/**
 * The receipt behind a registration, checked: a hash the wallet gave, or one
 * found from the log. Returns the hash only when its receipt holds the event.
 */
export async function confirmedRegistration(exactHash: Hex, hash: Hex | undefined): Promise<Hex | null> {
  const candidate =
    hash ?? (await recentLogHash(addresses.registry, REGISTERED_EVENT, { passportId: exactHash }));
  if (candidate === null) {
    return null;
  }
  const receipt = await chain.getTransactionReceipt({ hash: candidate });
  return holdsRegistration(receipt, exactHash) ? candidate : null;
}

/** The receipt behind a consent statement from this wallet, checked the same way. */
export async function confirmedConsent(passportId: Hex, writer: Hex, hash: Hex | undefined): Promise<Hex | null> {
  const candidate =
    hash ?? (await recentLogHash(addresses.consent, CONSENT_SET_EVENT, { passportId, writer }));
  if (candidate === null) {
    return null;
  }
  const receipt = await chain.getTransactionReceipt({ hash: candidate });
  return holdsConsentSet(receipt, passportId, writer) ? candidate : null;
}
