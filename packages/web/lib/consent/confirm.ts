import type { Hex } from "viem";
import { USE_FIELDS, getConsent, type Consent } from "@/lib/chain/consent";
import { watchState } from "@/lib/chain/watch";
import { ConfirmTimeout } from "@/lib/studio/confirm";

/**
 * Confirming a statement by the state it changed, not by the hash the wallet
 * returned.
 *
 * Privy's sponsored sends go out through its own path and can answer with an
 * empty hash while the transaction lands on Monad seconds later, so the wait
 * here reads the register itself until it holds this wallet's statement. The
 * wait is the shared one in lib/chain/watch, so a read that throws mid-wait is
 * logged and the window carries on.
 */

const POLL_MS = 1_000;
const WINDOW_MS = 90_000;

/** True when two statements say the same thing about all four uses. */
export function sameConsent(one: Consent, other: Consent): boolean {
  return USE_FIELDS.every((field) => one[field] === other[field]);
}

/**
 * Waits until the register's latest statement for this passport is the one this
 * wallet just sent.
 *
 * Three things have to agree, not one: the writer is this wallet, the four uses
 * and the conditions text are what went out, and it was written after the
 * statement that stood before the send. The last of those is what keeps a
 * holder who wrote the same words twice from being shown their old statement as
 * a receipt for the new one.
 */
export async function confirmSetConsent({
  passportId,
  wallet,
  sent,
  since,
  hash,
}: {
  passportId: Hex;
  wallet: Hex;
  sent: { consent: Consent; constraintInfo: string };
  /** When the statement that stood before this send was written, or 0 when there was none. */
  since: number;
  hash?: Hex;
}): Promise<{ hash?: Hex; at: number }> {
  try {
    const watched = await watchState<number | null>({
      read: async () => {
        const reading = await getConsent(passportId);
        const entry = reading.entry;
        if (entry === null || Number(entry.at) <= since) {
          return null;
        }
        const mine = entry.writer.toLowerCase() === wallet.toLowerCase();
        const same = sameConsent(entry.consent, sent.consent) && entry.constraintInfo === sent.constraintInfo;
        return mine && same ? Number(entry.at) : null;
      },
      done: (at) => at !== null,
      hash,
      windowMs: WINDOW_MS,
      pollMs: POLL_MS,
    });

    return { hash, at: watched.state ?? 0 };
  } catch (error) {
    // A wait that ran out is not a failed send: it may still land, so the
    // account it went from travels with the timeout for the "open it and look"
    // line the panel prints.
    if (error instanceof ConfirmTimeout) {
      throw new ConfirmTimeout(wallet, error.hash ?? hash);
    }
    throw error;
  }
}
