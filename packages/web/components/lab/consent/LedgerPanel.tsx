"use client";

import { useCallback } from "react";
import { ConsentLedger } from "@/components/consent/ConsentLedger";
import type { LedgerAnswer, LedgerEntry } from "@/components/consent/ledger";

/**
 * The bench's way of asking the chain what was in force on a day.
 *
 * The card itself knows no endpoint: the asking is handed in, so the same card
 * can sit behind this lab route today and behind whatever the app settles on
 * when the variant is picked.
 */
export function LedgerPanel({
  id,
  registeredAt,
  now,
  entries,
  standing,
  standard,
}: {
  id: string;
  registeredAt: number;
  now: number;
  entries: LedgerEntry[];
  standing: LedgerAnswer;
  standard: string;
}) {
  const ask = useCallback(
    async (unixSeconds: number, signal: AbortSignal): Promise<LedgerAnswer> => {
      const answer = await fetch(`/api/lab/consent-at?id=${id}&at=${unixSeconds}`, { signal });
      const body = (await answer.json()) as { error?: string; stated?: boolean; entry?: LedgerEntry | null };

      if (!answer.ok) {
        throw new Error(typeof body.error === "string" ? body.error : `the reader answered ${answer.status}`);
      }
      return { stated: body.stated === true, entry: body.entry ?? null };
    },
    [id],
  );

  return (
    <ConsentLedger
      registeredAt={registeredAt}
      now={now}
      entries={entries}
      standing={standing}
      standard={standard}
      ask={ask}
      className="mt-6"
    />
  );
}
