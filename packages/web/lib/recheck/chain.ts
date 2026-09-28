"use server";

import { unstable_cache } from "next/cache";
import { headers } from "next/headers";
import { decodeEventLog, toEventSelector, TransactionReceiptNotFoundError, type Hex, type Log } from "viem";
import { callerFromHeaders, withinLimit } from "@/lib/api/limit";
import { CACHE_TAGS, addresses, chain, registryAbi } from "@/lib/chain/client";
import { isChainlinkReceiver, reportSender, sameAddress } from "@/lib/chain/receivers";
import { getAttestations, passportTag } from "@/lib/chain/registry";
import type { ConfirmedReport } from "./state";

const ID_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/**
 * Held for half a minute. The control asks at most once a minute per open tab
 * while a finished run waits for the chain, so this caps what a page left open,
 * or a stranger calling the action directly, costs the RPC to two reads a
 * minute for any one passport.
 */
const HOLD_SECONDS = 30;

/**
 * A report transaction that is confirmed stays confirmed: its receipt, its
 * block and its log are history. So the answer is kept for a month, and only
 * a transaction that could not be confirmed is asked about again soon.
 */
const REPORT_HOLD_SECONDS = 30 * 86_400;

/**
 * Whether this caller may make one more of these reads this minute.
 *
 * Both reads are server actions anyone can call with any id, and every id they
 * have not seen is a fresh RPC read, so the hold alone does not bound what one
 * script in a loop costs. The control asks once a minute per open tab, far
 * under the limit. Each read keeps its own count.
 */
async function allowed(read: string): Promise<boolean> {
  return withinLimit(read, callerFromHeaders(await headers())).ok;
}

/** The registry's own event for a verdict it stored. */
const VERIFICATION_ATTESTED = toEventSelector("VerificationAttested(bytes32,address,bool,uint16,bytes32)");

/**
 * When the newest Chainlink re-check on a passport was written, in unix
 * seconds, or null when the registry holds none.
 *
 * This is the chain check the re-check control makes before it says "done"
 * (R10). It reads the registry itself rather than the index or the verify
 * service, and a row from a writer the app cannot name does not count: a
 * finished request is Moolam's own run, and only a Chainlink receiver's row
 * can be its verdict. Anyone on the internet can call this, so it takes an id
 * and nothing else, and an id that is not a bytes32 reads as nothing held. A
 * caller over the limit gets undefined, the answer of a read that failed,
 * which the control keeps as pending and never as done.
 */
export async function newestChainlinkRecheck(id: string): Promise<number | null | undefined> {
  if (!ID_PATTERN.test(id)) {
    return null;
  }
  if (!(await allowed("recheck-newest"))) {
    return undefined;
  }
  const passport = id as Hex;
  const held = unstable_cache(
    async () => {
      const rows = await getAttestations(passport);
      const times = rows.filter((row) => isChainlinkReceiver(row.receiver)).map((row) => Number(row.at));
      return times.length === 0 ? null : Math.max(...times);
    },
    ["moolam-recheck-on-chain", passport.toLowerCase()],
    { revalidate: HOLD_SECONDS, tags: [CACHE_TAGS.chain, passportTag(passport)] },
  );
  return await held();
}

/** Thrown inside the long hold for a transaction that is not confirmed, so the miss is not kept there. */
class NotConfirmed extends Error {
  constructor() {
    super("this transaction is not a confirmed report for this passport");
    this.name = "NotConfirmed";
  }
}

/**
 * Transactions recently found not to be a confirmed report, and until when
 * that answer stands. Bounded, so a stranger inventing hashes cannot grow it.
 */
const misses = new Map<string, number>();
const MISSES_MAX = 2_000;

function heldMiss(key: string, now: number): boolean {
  const until = misses.get(key);
  if (until === undefined) {
    return false;
  }
  if (until > now) {
    return true;
  }
  misses.delete(key);
  return false;
}

function noteMiss(key: string, now: number): void {
  misses.delete(key);
  if (misses.size >= MISSES_MAX) {
    const oldest = misses.keys().next();
    if (!oldest.done) {
      misses.delete(oldest.value);
    }
  }
  misses.set(key, now + HOLD_SECONDS * 1_000);
}

/**
 * What the chain says about the report transaction the queue named for a
 * passport, or null when it is not that passport's verdict from Moolam.
 *
 * The runner answers a request for a picture it already re-checked with the
 * report it sent before, so that report can be older than the request. The
 * time rule above cannot tell such an answer from a stale one; the receipt
 * can. It counts only when the transaction succeeded, was sent from the CRE
 * wallet, and carries the registry's VerificationAttested log for this
 * passport from a Chainlink receiver. The date and the verdict are then the
 * chain's, never the queue's.
 *
 * Anyone can call this, so both values must be 32 bytes of hex, and anything
 * else reads as not confirmed. A read that fails throws, and a caller over the
 * limit gets undefined; the control treats both as not yet.
 */
export async function confirmedReport(id: string, tx: string): Promise<ConfirmedReport | null | undefined> {
  if (!ID_PATTERN.test(id) || !ID_PATTERN.test(tx)) {
    return null;
  }
  if (!(await allowed("recheck-report"))) {
    return undefined;
  }
  const passport = id.toLowerCase() as Hex;
  const hash = tx.toLowerCase() as Hex;
  const key = `${passport}:${hash}`;
  if (heldMiss(key, Date.now())) {
    return null;
  }

  const held = unstable_cache(
    async () => {
      const report = await readReport(passport, hash);
      if (report === null) {
        throw new NotConfirmed();
      }
      return report;
    },
    ["moolam-recheck-report", passport, hash],
    { revalidate: REPORT_HOLD_SECONDS },
  );

  try {
    return await held();
  } catch (error) {
    if (error instanceof NotConfirmed || (error as Error | undefined)?.name === "NotConfirmed") {
      noteMiss(key, Date.now());
      return null;
    }
    throw error;
  }
}

async function readReport(passport: Hex, hash: Hex): Promise<ConfirmedReport | null> {
  let receipt: Awaited<ReturnType<typeof chain.getTransactionReceipt>>;
  try {
    receipt = await chain.getTransactionReceipt({ hash });
  } catch (error) {
    // Not mined yet, or never sent: not confirmed, and worth asking again soon.
    if (error instanceof TransactionReceiptNotFoundError) {
      return null;
    }
    throw error;
  }

  if (receipt.status !== "success" || !sameAddress(receipt.from, reportSender())) {
    return null;
  }
  const verdict = receipt.logs.map((log) => verdictIn(log, passport)).find((found) => found !== null);
  if (verdict === undefined || verdict === null) {
    return null;
  }

  const block = await chain.getBlock({ blockNumber: receipt.blockNumber });
  return { at: Number(block.timestamp), ...verdict };
}

/** The verdict in one receipt log, when it is the registry's attestation for this passport from a Chainlink receiver. */
function verdictIn(log: Log, passport: Hex): Omit<ConfirmedReport, "at"> | null {
  if (
    !sameAddress(log.address, addresses.registry) ||
    log.topics[0]?.toLowerCase() !== VERIFICATION_ATTESTED ||
    log.topics[1]?.toLowerCase() !== passport
  ) {
    return null;
  }
  try {
    const { args } = decodeEventLog({
      abi: registryAbi,
      eventName: "VerificationAttested",
      data: log.data,
      topics: log.topics,
    });
    const fields = args as unknown as { receiver: Hex; matched: boolean; distance: number };
    return isChainlinkReceiver(fields.receiver) ? { matched: fields.matched, distance: Number(fields.distance) } : null;
  } catch {
    return null;
  }
}
