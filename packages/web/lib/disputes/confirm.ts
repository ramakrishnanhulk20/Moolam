import type { Hex } from "viem";
import { chain } from "@/lib/chain/client";
import { watchState } from "@/lib/chain/watch";
import { DisputeStatus, getDispute, withdrawable, type Dispute } from "@/lib/chain/registry";
import { ConfirmTimeout } from "@/lib/studio/confirm";

/**
 * Confirming a dispute write by the state it changes, not by the hash the
 * wallet returned.
 *
 * Privy's sponsored sends can answer with an empty hash while the transaction
 * lands on Monad seconds later, so every wait here watches the registry itself:
 * the dispute appearing, its status leaving Open, or the credit going to zero.
 * The wait itself is the one in lib/chain/watch, so a read that throws mid-wait
 * is logged and the window carries on rather than ending in an error about a
 * network blip.
 */

const POLL_MS = 1_000;
const WINDOW_MS = 90_000;

/** What one settled dispute became, as the registry holds it. */
export type Outcome = "upheld" | "rejected";

export interface DisputeConfirmed {
  hash?: Hex;
  blockNumber?: bigint;
  /** The dispute as the registry holds it once the write landed. */
  dispute?: Dispute;
}

export interface ResolveConfirmed extends DisputeConfirmed {
  /** Read from the record, never from the button that was pressed. Null when the chain did not say. */
  outcome: Outcome | null;
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
  const dispute = await watchDispute({
    wallet: challenger,
    hash,
    read: async () => {
      const found = await getDispute(passportId);
      if (found === null || found.status !== DisputeStatus.Open) {
        return null;
      }
      return found.challenger.toLowerCase() === challenger.toLowerCase() ? found : null;
    },
  });

  return { hash, blockNumber: await blockOf(hash), dispute: dispute ?? undefined };
}

/** Waits until the dispute on this passport is no longer open, and says which way it went. */
export async function confirmResolve({
  passportId,
  wallet,
  hash,
}: {
  passportId: Hex;
  /** The account the transaction went from, so a wait that runs out can point at it. */
  wallet?: Hex;
  hash?: Hex;
}): Promise<ResolveConfirmed> {
  const dispute = await watchDispute({
    wallet,
    hash,
    read: async () => {
      const found = await getDispute(passportId);
      return found === null || found.status === DisputeStatus.Open ? null : found;
    },
  });

  return { hash, blockNumber: await blockOf(hash), dispute: dispute ?? undefined, outcome: outcomeOf(dispute) };
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
  await watchDispute({
    wallet,
    hash,
    read: async () => {
      const owed = await withdrawable(wallet);
      return owed < owedBefore ? owed : null;
    },
  });

  return { hash, blockNumber: await blockOf(hash) };
}

/** Which way the resolver went, taken from the status the registry holds. */
export function outcomeOf(dispute: Dispute | null | undefined): Outcome | null {
  if (dispute === null || dispute === undefined) {
    return null;
  }
  if (dispute.status === DisputeStatus.Upheld) {
    return "upheld";
  }
  return dispute.status === DisputeStatus.Rejected ? "rejected" : null;
}

/**
 * One dispute wait, with the wallet kept on a window that runs out.
 *
 * A wait that ran out is not a failed send, and the only useful thing left to
 * offer is the account itself: open it and look. That needs the address the
 * transaction went from, which the shared wait does not know.
 */
async function watchDispute<T>({
  read,
  wallet,
  hash,
}: {
  read: () => Promise<T | null>;
  wallet?: Hex;
  hash?: Hex;
}): Promise<T | null> {
  try {
    const watched = await watchState<T | null>({
      read,
      done: (state) => state !== null,
      hash,
      windowMs: WINDOW_MS,
      pollMs: POLL_MS,
    });
    return watched.state;
  } catch (error) {
    if (error instanceof ConfirmTimeout) {
      throw new ConfirmTimeout(wallet ?? error.wallet, error.hash ?? hash);
    }
    throw error;
  }
}

/** The block the transaction sat in, when there is a hash to ask about. Never worth failing a landed write. */
async function blockOf(hash?: Hex): Promise<bigint | undefined> {
  if (hash === undefined) {
    return undefined;
  }
  return chain
    .getTransactionReceipt({ hash })
    .then((receipt) => receipt.blockNumber)
    .catch(() => undefined);
}
