import type { Hex } from "viem";
import { chain } from "./client";
import { ConfirmTimeout } from "@/lib/studio/confirm";

/**
 * One way to wait for a write, for every flow that makes one.
 *
 * A write is confirmed by the state it changed and not by the hash the wallet
 * returned. Privy's sponsored sends go out through its own EIP-7702 path and
 * can answer with an empty hash while the transaction lands on Monad seconds
 * later, so a screen that waits on that hash shows a failure for a write that
 * worked and invites a second send. The poll is the truth here; a real hash,
 * when there is one, is the faster answer and is raced against the poll.
 *
 * A read that throws mid-wait is not the end of the wait either. An RPC
 * hiccup three seconds into a ninety second window used to end it with an
 * error about a network blip rather than about the transaction.
 */

/** The wallet took the transaction and Monad mined it as a failure. Nothing was written. */
export class Reverted extends Error {
  readonly hash?: Hex;

  constructor(hash?: Hex) {
    super(`Monad mined this transaction and it reverted${hash === undefined ? "" : `: ${hash}`}`);
    this.name = "Reverted";
    this.hash = hash;
  }
}

/** The screen moved on, so the wait was dropped. Nothing is known about the write either way. */
export class Aborted extends Error {
  constructor() {
    super("this wait was dropped before the chain answered");
    this.name = "Aborted";
  }
}

export interface WatchRequest<T> {
  /** The chain read that shows the write. Its rejections are logged and the window carries on. */
  read: () => Promise<T>;
  /** Whether what came back is the write landing. */
  done: (state: T) => boolean;
  /** The hash the wallet returned, when it returned one. */
  hash?: Hex;
  /** How long Monad gets before the screen says so out loud. */
  windowMs: number;
  /** How long between reads. */
  pollMs: number;
  signal?: AbortSignal;
}

export interface Watched<T> {
  state: T;
  hash?: Hex;
  /** Only ever "success": a reverted receipt is thrown, not returned. */
  receiptStatus?: "success";
}

/** The sleep tick that loses the race when the receipt turns up first. */
const PENDING = Symbol("pending");

export async function watchState<T>({
  read,
  done,
  hash,
  windowMs,
  pollMs,
  signal,
}: WatchRequest<T>): Promise<Watched<T>> {
  let receipt =
    hash === undefined
      ? null
      : chain
          .waitForTransactionReceipt({ hash, timeout: windowMs })
          .then((mined) => ({ reverted: mined.status !== "success" }))
          // A receipt that never turns up decides nothing. The state poll does.
          .catch(() => null);

  let receiptStatus: "success" | undefined;
  const deadline = Date.now() + windowMs;

  for (;;) {
    if (signal?.aborted === true) {
      throw new Aborted();
    }

    const state = await attempt(read);
    if (state.read && done(state.value)) {
      return { state: state.value, hash, receiptStatus };
    }

    if (Date.now() >= deadline) {
      throw new ConfirmTimeout(undefined, hash);
    }

    if (receipt === null) {
      await sleep(pollMs, signal);
      continue;
    }

    const settled = await Promise.race([receipt, sleep(pollMs, signal).then((): typeof PENDING => PENDING)]);
    if (settled === PENDING) {
      continue;
    }

    receipt = null;
    if (settled === null) {
      continue;
    }
    if (settled.reverted) {
      throw new Reverted(hash);
    }
    receiptStatus = "success";
  }
}

type Attempt<T> = { read: true; value: T } | { read: false };

async function attempt<T>(read: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { read: true, value: await read() };
  } catch (error) {
    // Said out loud, because a wait that quietly swallows every read is a wait
    // nobody can debug when it ends in a timeout.
    console.warn("a read while waiting for a write failed, the wait continues:", error);
    return { read: false };
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Aborted());
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      reject(new Aborted());
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
