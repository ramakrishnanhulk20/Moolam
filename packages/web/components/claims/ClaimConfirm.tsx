"use client";

import type { Hex } from "viem";
import { useClaimConfirm, type ConfirmRow } from "@/lib/claims/useClaimConfirm";
import type { PendingGroup } from "@/lib/claims/usePendingConfirm";
import { ConfirmCard } from "./ConfirmCard";

/**
 * One confirm card with its send wired in. Loaded only when a platform has
 * handed something over, so the send code never reaches a page with nothing
 * to confirm.
 */
export function ClaimConfirm({
  group,
  wallet,
  onReread,
  onDone,
}: {
  group: PendingGroup;
  wallet: Hex;
  onReread: () => void;
  onDone?: (txHash: Hex, rows: ConfirmRow[]) => void;
}) {
  const confirm = useClaimConfirm({ group, wallet, onDone });

  return (
    <ConfirmCard
      rows={confirm.rows}
      terms={group.terms}
      step={confirm.step}
      failure={confirm.failure}
      txHash={confirm.txHash}
      onConfirm={confirm.actions.confirm}
      onRecheck={confirm.actions.recheck}
      onReread={onReread}
    />
  );
}
