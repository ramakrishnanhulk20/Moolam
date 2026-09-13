const TEN_MINUTES_MS = 10 * 60 * 1000;

/** What one payment authorisation bought, and the answer that went out with it. */
export interface LedgerEntry {
  state: "pending" | "settled";
  payload: unknown;
  headers: Record<string, string>;
  /** Unix milliseconds, when the entry was written. The TTL is measured from here. */
  at: number;
}

export interface PaymentLedger {
  get: (nonce: string) => LedgerEntry | undefined;
  remember: (nonce: string, entry: Omit<LedgerEntry, "at">) => void;
  sweep: () => void;
}

/**
 * The answer each payment has already bought, keyed by the EIP-3009 nonce the
 * payer signed.
 *
 * One authorisation is one signature for one amount, so a repeat of it must not
 * be settled a second time. The answer it bought is handed back instead, until
 * the entry expires.
 *
 * Like the generation quota, this lives in this process's memory only. It is
 * gone on a restart and a second copy of the service keeps its own, so a repeat
 * that lands after a redeploy, or on another instance, still reaches the
 * facilitator twice. What stops that from charging twice is the chain, not this
 * map: a spent EIP-3009 nonce cannot be spent again, so the second settle call
 * fails. What the map adds is that the payer gets the answer they paid for.
 */
export function paymentLedger(ttlMs: number = TEN_MINUTES_MS): PaymentLedger {
  const entries = new Map<string, LedgerEntry>();

  const sweep = (): void => {
    const cutoff = Date.now() - ttlMs;
    for (const [nonce, entry] of entries) {
      if (entry.at <= cutoff) {
        entries.delete(nonce);
      }
    }
  };

  return {
    get(nonce: string): LedgerEntry | undefined {
      sweep();
      return entries.get(nonce);
    },

    remember(nonce: string, entry: Omit<LedgerEntry, "at">): void {
      entries.set(nonce, { ...entry, at: Date.now() });
    },

    sweep,
  };
}
