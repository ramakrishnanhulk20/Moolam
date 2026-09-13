import type { Hex } from "viem";
import { chain } from "@/lib/chain/client";
import { DisputeStatus, getDispute, withdrawable, type Dispute } from "@/lib/chain/registry";
import { ConfirmTimeout } from "@/lib/studio/confirm";

/**
 * Confirming a dispute write by the state it changes, not by the hash the
 * wallet returned.
 *
 * Privy's sponsored sends can answer with an empty hash while the transaction
 * lands on Monad seconds later, so every wait here watches the registry itself:
 * the dispute appearing, its status leaving Open, or the credit going to zero.
 * A real hash is raced against the poll rather than depended on.
 */

const POLL_MS = 1_000;
const WINDOW_MS = 90_000;

/** The sleep tick that loses the race when the receipt turns up first. */
const PENDING = Symbol("pending");

export interface DisputeConfirmed {
  hash?: Hex;
  blockNumber?: bigint;
  /** The dispute as the registry holds it once the write landed. */
  dispute?: Dispute;
}

/** Waits until the registry holds an open dispute on this passport from this challenger. */
export async function confirmFlag({
  passportId,
  challenger,
  hash,
}: {
  passportId: Hex;
  challenger: Hex;
  hash?: Hex;
}): Promise<DisputeConfirmed> {
  const watched = await watch(async () => {
    const dispute = await getDispute(passportId);
    if (dispute === null || dispute.status !== DisputeStatus.Open) {
      return null;
    }
    return dispute.challenger.toLowerCase() === challenger.toLowerCase() ? dispute : null;
  }, hash);

  return { hash: watched.hash, blockNumber: watched.blockNumber, dispute: watched.state ?? undefined };
}

/** Waits until the dispute on this passport is no longer open, whichever way it went. */
export async function confirmResolve({ passportId, hash }: { passportId: Hex; hash?: Hex }): Promise<DisputeConfirmed> {
  const watched = await watch(async () => {
    const dispute = await getDispute(passportId);
    return dispute === null || dispute.status === DisputeStatus.Open ? null : dispute;
  }, hash);

  return { hash: watched.hash, blockNumber: watched.blockNumber, dispute: watched.state ?? undefined };
}

/**
 * Waits until the registry owes this address less than it did.
 *
 * withdraw zeroes the whole credit, so the balance falling is the whole answer
 * and no amount has to be matched.
 */
export async function confirmWithdraw({
  wallet,
  owedBefore,
  hash,
}: {
  wallet: Hex;
  owedBefore: bigint;
  hash?: Hex;
}): Promise<DisputeConfirmed> {
  const watched = await watch(async () => {
    const owed = await withdrawable(wallet);
    return owed < owedBefore ? owed : null;
  }, hash);

  return { hash: watched.hash, blockNumber: watched.blockNumber };
}

interface Watched<T> {
  /** Null only when the receipt won the race and the read has not caught up yet. */
  state: T | null;
  hash?: Hex;
  blockNumber?: bigint;
}

async function watch<T>(read: () => Promise<T | null>, hash?: Hex): Promise<Watched<T>> {
  let receipt =
    hash === undefined
      ? null
      : chain
          .waitForTransactionReceipt({ hash, timeout: WINDOW_MS })
          .then((mined) => ({ block: mined.blockNumber, reverted: mined.status !== "success" }))
          // A receipt that never turns up decides nothing. The state poll does.
          .catch(() => null);

  const deadline = Date.now() + WINDOW_MS;

  for (;;) {
    const state = await read();
    if (state !== null) {
      return { state, hash };
    }

    if (Date.now() >= deadline) {
      throw new ConfirmTimeout(undefined, hash);
    }

    if (receipt === null) {
      await sleep(POLL_MS);
      continue;
    }

    const settled = await Promise.race([receipt, sleep(POLL_MS).then((): typeof PENDING => PENDING)]);
    if (settled === PENDING) {
      continue;
    }

    receipt = null;
    if (settled === null) {
      continue;
    }
    if (settled.reverted) {
      throw new Error(`Monad mined this transaction and it reverted: ${hash}`);
    }

    return { state: await read(), hash, blockNumber: settled.block };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
