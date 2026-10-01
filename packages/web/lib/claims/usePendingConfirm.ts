"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Hex } from "viem";
import { addresses, chain, registryAbi } from "@/lib/chain/client";
import { getConsent } from "@/lib/chain/consent";
import type { ClaimsAnswer } from "./client";
import { heldBatch, ownerOrNull, type HolderReads } from "./confirm";
import { deliveredByTerms, type TermsGroup } from "./offers";

/** The chain reads that choose a batch: who holds each passport now, and who last wrote terms on it. */
export const holderReads: HolderReads = {
  ownerOf: async (id) =>
    await ownerOrNull(() => chain.readContract({ address: addresses.registry, abi: registryAbi, functionName: "ownerOf", args: [BigInt(id)] })),
  latestEntry: async (id) => {
    const entry = (await getConsent(id)).entry;
    return entry === null ? null : { writer: entry.writer as Hex, at: Number(entry.at) };
  },
};

/** A group of delivered pictures with the exact passports one press would confirm. */
export interface PendingGroup extends TermsGroup {
  ids: Hex[];
}

export interface PendingConfirm {
  status: "idle" | "reading" | "ready" | "unreadable";
  groups: PendingGroup[];
  reread: () => void;
}

/**
 * The delivered pictures still to confirm, read from the chain when the list
 * arrives: for each group of terms, the passports this wallet holds now and has
 * not written terms on, at most 32 (P37). A group with none left is dropped, so
 * a picture confirmed in another tab, or passed on, does not ask again.
 *
 * Keyed on the delivered passports and their terms, so the list being read
 * again during a handover costs no chain reads unless a delivery changed it.
 */
export function usePendingConfirm(answer: ClaimsAnswer | null, wallet: Hex): PendingConfirm {
  const groups = useMemo(() => deliveredByTerms(answer?.waiting ?? []), [answer]);
  const key = groups.map((group) => `${group.key}:${group.entries.map((entry) => entry.passportId).join(",")}`).join("|");
  const [round, setRound] = useState(0);
  const [result, setResult] = useState<{ for: string; round: number; status: PendingConfirm["status"]; groups: PendingGroup[] }>({
    for: "",
    round: -1,
    status: "idle",
    groups: [],
  });

  useEffect(() => {
    if (groups.length === 0) return;
    let current = true;
    void (async () => {
      try {
        const read = await Promise.all(
          groups.map(async (group) => ({ ...group, ids: (await heldBatch(group.entries, wallet, holderReads)).ids })),
        );
        if (current) setResult({ for: key, round, status: "ready", groups: read.filter((group) => group.ids.length > 0) });
      } catch {
        if (current) setResult({ for: key, round, status: "unreadable", groups: [] });
      }
    })();
    return () => {
      current = false;
    };
    // The key is the groups' content; the array itself is new on every read of the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, wallet, round]);

  const reread = useCallback(() => setRound((was) => was + 1), []);

  if (groups.length === 0) return { status: "idle", groups: [], reread };
  // A read in flight is "reading"; the groups from the last read of the same passports stay on screen meanwhile.
  const settled = result.for === key && result.round === round;
  return { status: settled ? result.status : "reading", groups: result.for === key ? result.groups : [], reread };
}
