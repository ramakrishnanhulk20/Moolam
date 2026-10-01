import { z } from "zod";
import { deliveriesAnswer, type DeliveriesAnswer } from "./answers.js";
import { assertMonad, readerFor, walletAddress, type ChainReader, type PlatformWalletClient } from "./chain.js";
import { MoolamPlatformError } from "./errors.js";
import { assertPlatformKey } from "./prepare.js";
import { callService, checkedUrl, type ServiceTarget } from "./service.js";
import { checkedRecipient, holderOf, sendTransfer } from "./transfer.js";

export interface RunDeliveriesOptions {
  /** The Moolam verify service, for example https://verify.example.com. */
  verifyUrl: string;
  /** The platform's Moolam key. Sent only in the Authorization header. */
  platformKey: string;
  /** The platform's wallet: it holds the passports waiting for their people, and pays each hand-over. */
  walletClient: PlatformWalletClient;
  /** A viem public client on Monad, for the ownerOf reads and the simulations. */
  publicClient: ChainReader;
  /** Time between the end of one poll and the start of the next. Defaults to 5 seconds; at least 250 ms. */
  intervalMs?: number;
  /** Failed hand-overs before a ticket is reported failed and never tried again. Defaults to 3; 1 to 10. */
  maxTries?: number;
}

/** A running delivery worker. stop() lets the hand-over in flight finish, starts no other, and resolves when it is idle. */
export interface DeliveryWorker {
  stop(): Promise<void>;
}

const DEFAULT_INTERVAL_MS = 5_000;
const MIN_INTERVAL_MS = 250;
const MAX_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_TRIES = 3;
const MAX_MAX_TRIES = 10;
const LIST_TIMEOUT_MS = 15_000;

/**
 * Each hand-over waits for its receipt, so a poll is sequential; this many entries keeps one poll to
 * a few minutes at worst. Entries past it are read on a later poll, after the earlier ones have left
 * the list by landing or by being reported failed.
 */
const MAX_ENTRIES_PER_POLL = 50;

/**
 * Starts the platform's delivery worker: every intervalMs it reads GET /platform/deliveries, the
 * tickets whose people accepted their passports at Moolam, and hands each passport to the wallet the
 * service names for it (P26, P34).
 *
 * For each entry, in order: ownerOf is read now and the entry is skipped unless the platform's wallet
 * holds the passport, so a passport already handed over or moved elsewhere is never sent again; the
 * destination passes checkedRecipient, the same strict rule transferPassport applies (P31); the
 * transfer is simulated and only then sent; and no ticket is sent more than once in one poll. A
 * refused destination, a refused simulation or a failed transaction counts as one failed try; after
 * maxTries the worker calls POST /platform/deliveries/:ticketId/failed and never tries that ticket
 * again in this process. Delivered is the service's word to say, from the chain (P27); the worker
 * reports nothing on success.
 *
 * The worker logs nothing and throws nothing once started: a poll that cannot reach the service or
 * the chain sends nothing and is tried again at the next interval.
 *
 * Throws MoolamPlatformError, before the first poll: "invalid-input" for a bad key, URL, interval or
 * try count, and "wrong-chain" when either client is not on Monad.
 */
export async function runDeliveries(options: RunDeliveriesOptions): Promise<DeliveryWorker> {
  const { walletClient, publicClient } = options;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxTries = options.maxTries ?? DEFAULT_MAX_TRIES;
  if (!Number.isInteger(intervalMs) || intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS) {
    throw new MoolamPlatformError("invalid-input", `intervalMs must be a whole number from ${MIN_INTERVAL_MS} to ${MAX_INTERVAL_MS}`);
  }
  if (!Number.isInteger(maxTries) || maxTries < 1 || maxTries > MAX_MAX_TRIES) {
    throw new MoolamPlatformError("invalid-input", `maxTries must be a whole number from 1 to ${MAX_MAX_TRIES}`);
  }
  assertPlatformKey(options.platformKey);
  checkedUrl(options.verifyUrl, "verifyUrl");
  await assertMonad(publicClient);
  await assertMonad(readerFor(walletClient));

  const target: ServiceTarget = { verifyUrl: options.verifyUrl, platformKey: options.platformKey };
  const wallet = walletAddress(walletClient);
  // Only tickets that failed at least once are remembered, so the memory is bounded by the failures,
  // and a given-up ticket stays given up even if the service keeps listing it.
  const failedTries = new Map<string, number>();
  const reported = new Set<string>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> = Promise.resolve();

  const reportFailed = async (ticketId: string): Promise<void> => {
    if (reported.has(ticketId)) return;
    try {
      await callService(
        target,
        { method: "POST", path: `/platform/deliveries/${encodeURIComponent(ticketId)}/failed`, what: "a failed delivery", timeoutMs: LIST_TIMEOUT_MS },
        z.unknown(),
      );
      reported.add(ticketId);
    } catch {
      // Left unreported, so the next poll reports it again; it is never sent again either way.
    }
  };

  const deliverOne = async (entry: DeliveriesAnswer["deliveries"][number]): Promise<void> => {
    const tries = failedTries.get(entry.ticketId) ?? 0;
    if (tries >= maxTries) {
      await reportFailed(entry.ticketId);
      return;
    }
    let holder;
    try {
      holder = await holderOf(publicClient, entry.passportId);
    } catch {
      return;
    }
    if (holder !== wallet) return;
    try {
      const recipient = checkedRecipient(entry.destination, wallet);
      await sendTransfer(walletClient, publicClient, entry.passportId, wallet, recipient);
      failedTries.delete(entry.ticketId);
    } catch {
      failedTries.set(entry.ticketId, tries + 1);
      if (tries + 1 >= maxTries) {
        await reportFailed(entry.ticketId);
      }
    }
  };

  const poll = async (): Promise<void> => {
    const answer = await callService(target, { method: "GET", path: "/platform/deliveries", what: "the deliveries list", timeoutMs: LIST_TIMEOUT_MS }, deliveriesAnswer);
    const thisPoll = new Set<string>();
    for (const entry of answer.deliveries.slice(0, MAX_ENTRIES_PER_POLL)) {
      if (stopped) return;
      if (thisPoll.has(entry.ticketId)) continue;
      thisPoll.add(entry.ticketId);
      await deliverOne(entry);
    }
  };

  const tick = (): void => {
    running = poll()
      .catch(() => undefined)
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, intervalMs);
      });
  };
  tick();

  return {
    async stop(): Promise<void> {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      await running;
    },
  };
}
