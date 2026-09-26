const TEN_MINUTES_MS = 10 * 60 * 1000;

/** What one payment authorisation bought, and the answer that went out with it. */
export interface LedgerEntry {
  /**
   * "settled" and "pending" answers went out. "unknown" is an answer held back because nobody
   * could say whether the transfer happened: it is handed over only once the chain shows it did.
   */
  state: "pending" | "settled" | "unknown";
  payload: unknown;
  headers: Record<string, string>;
  /**
   * The verified payment that bought the answer, in the one form a repeat is compared in: the
   * signature and every signed field. The payer and nonce are public on chain once a transfer
   * settles, so together they are only the key.
   */
  payment: string;
  /** The sha256 of the upload the answer is about, so a repeat must carry the same file. */
  upload: string;
  /** What the chain is asked about for an "unknown" entry. */
  proof?: unknown;
  /** Unix milliseconds, when the entry was written. The TTL is measured from here. */
  at: number;
}

export interface PaymentLedger {
  get: (key: string) => LedgerEntry | undefined;
  remember: (key: string, entry: Omit<LedgerEntry, "at">) => void;
  forget: (key: string) => void;
  sweep: () => void;
}

/**
 * The answer each payment has already bought, keyed by the payer's address and
 * the EIP-3009 nonce they signed, together. A nonce is unique per payer and not
 * across payers, so a second payer signing the same nonce must never land on the
 * first payer's entry (review pass 6, V48).
 *
 * One authorisation is one signature for one amount, so a repeat of it must not
 * be settled a second time. The answer it bought is handed back instead, until
 * the entry expires, and only to a request carrying that same payment and that
 * same file: the caller decides that by comparing `payment` and `upload`.
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
    for (const [key, entry] of entries) {
      if (entry.at <= cutoff) {
        entries.delete(key);
      }
    }
  };

  return {
    get(key: string): LedgerEntry | undefined {
      sweep();
      return entries.get(key);
    },

    remember(key: string, entry: Omit<LedgerEntry, "at">): void {
      entries.set(key, { ...entry, at: Date.now() });
    },

    forget(key: string): void {
      entries.delete(key);
    },

    sweep,
  };
}
