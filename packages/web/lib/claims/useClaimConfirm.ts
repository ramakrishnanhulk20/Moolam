"use client";

import { useSendTransaction, useWallets } from "@privy-io/react-auth";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Hex } from "viem";
import { chain, consentAbi } from "@/lib/chain/client";
import { consentStruct } from "@/lib/consent/call";
import { confirmSetConsent } from "@/lib/consent/confirm";
import { describeConsentFailure, type ConsentFailure } from "@/lib/consent/failure";
import { confirmedConsent } from "@/lib/cosign/landed";
import { refreshPassport } from "@/lib/passport/refresh";
import { transactionHash } from "@/lib/studio/confirm";
import { ensureMonad } from "@/lib/studio/wallet";
import { artFor, type ClaimArt } from "./art";
import { lookForReceipt, runConfirm, type ConfirmDeps, type ConfirmEvent, type SentBatch } from "./confirm";
import { holderReads, type PendingGroup } from "./usePendingConfirm";

/** A batch holds up to 32; each page is its own server call, so the loop stops short of the whole batch. */
const REFRESH_LIMIT = 24;

/** Expires the held page of each confirmed passport, one after another. A failed call is skipped. */
async function refreshConfirmed(ids: readonly Hex[]): Promise<void> {
  for (const id of ids.slice(0, REFRESH_LIMIT)) {
    await refreshPassport(id).catch(() => undefined);
  }
}

export type ConfirmStep = "ready" | "checking" | "changed" | "sending" | "confirming" | "done" | "failed";

export interface ConfirmRow {
  passportId: Hex;
  platform: string;
  /** Null while the picture is read; an empty object when it could not be. */
  art: ClaimArt | null;
}

export interface ClaimConfirm {
  step: ConfirmStep;
  /** Exactly the passports the press will send, in order. */
  rows: ConfirmRow[];
  failure: ConsentFailure | null;
  txHash?: Hex;
  actions: { confirm: () => void; recheck: () => void };
}

/**
 * One group of delivered pictures and the press that confirms them, sent the
 * way the studio sends: the embedded wallet put on Monad, the call simulated so
 * a revert comes back named, then one sponsored send from that wallet, named
 * out loud so a session with two wallets cannot send it from the other.
 *
 * The ids drawn are the ones the chain read chose when the list arrived. The
 * press reads them again and sends nothing if they changed (runConfirm), so the
 * person always signs for exactly the pictures in front of them.
 */
export function useClaimConfirm({
  group,
  wallet,
  onDone,
}: {
  group: PendingGroup;
  wallet: Hex;
  onDone?: (txHash: Hex, rows: ConfirmRow[]) => void;
}): ClaimConfirm {
  const { wallets } = useWallets();
  const { sendTransaction } = useSendTransaction();
  const embedded = useMemo(
    () => wallets.find((entry) => entry.walletClientType === "privy" && entry.address.toLowerCase() === wallet.toLowerCase()),
    [wallets, wallet],
  );

  const [step, setStep] = useState<ConfirmStep>("ready");
  const [art, setArt] = useState<Record<string, ClaimArt>>({});
  const [failure, setFailure] = useState<ConsentFailure | null>(null);
  const [txHash, setTxHash] = useState<Hex | undefined>();
  const out = useRef<SentBatch | null>(null);
  const live = useRef(true);
  const ids = group.ids;
  const idsKey = ids.join(",");

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    let current = true;
    void Promise.all(ids.map(async (id) => [id, await artFor(id)] as const)).then((found) => {
      if (current) setArt(Object.fromEntries(found));
    });
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the passports, not the array that carries them
  }, [idsKey]);

  const deps = useMemo<ConfirmDeps>(
    () => ({
      ...holderReads,
      simulate: async (request, from) => {
        if (embedded === undefined) throw new Error("the wallet this page signed in with is not connected");
        await ensureMonad(embedded);
        await chain.simulateContract({
          address: request.to,
          abi: consentAbi,
          functionName: "setConsentBatch",
          args: [request.ids, consentStruct(request.draft.consent), request.draft.constraintInfo],
          account: from,
        });
      },
      send: async (request, from) => {
        const answer = await sendTransaction(
          { to: request.to, data: request.data, chainId: request.chainId },
          { sponsor: true, address: from },
        );
        return transactionHash(answer.hash);
      },
      waitLanded: async (input) => {
        await confirmSetConsent(input);
      },
      receipt: async (passportId, from, hash) => {
        const found = await confirmedConsent(passportId, from, hash);
        return found === null ? null : { hash: found, receipt: await chain.getTransactionReceipt({ hash: found }) };
      },
    }),
    [embedded, sendTransaction],
  );

  const platformOf = useMemo(
    () => new Map(group.entries.map((entry) => [entry.passportId.toLowerCase(), entry.platform.name])),
    [group.entries],
  );
  const rows: ConfirmRow[] = ids.map((id) => ({ passportId: id, platform: platformOf.get(id) ?? "", art: art[id] ?? null }));
  const rowsNow = useRef(rows);
  useEffect(() => {
    rowsNow.current = rows;
  });

  const onEvent = useCallback(
    (event: ConfirmEvent) => {
      if (!live.current) return;
      if (event.at === "done") {
        out.current = null;
        // The passport pages held the old statement; a link opened from here must read the new one.
        void refreshConfirmed(rowsNow.current.map((row) => row.passportId));
        setTxHash(event.txHash);
        setStep("done");
        onDone?.(event.txHash, rowsNow.current);
        return;
      }
      if (event.at === "unconfirmed") {
        setFailure({ key: "confirmPending", next: "recheck" });
        setStep("failed");
        return;
      }
      setFailure(null);
      setStep(event.at);
    },
    [onDone],
  );

  const failed = useCallback((error: unknown) => {
    if (!live.current) return;
    const described = describeConsentFailure(error);
    // A wait that ran out keeps what is out: it may still land, so it is only ever looked for again.
    if (described.key !== "confirmPending") out.current = null;
    setFailure(described);
    setStep("failed");
  }, []);

  const busy = step === "checking" || step === "sending" || step === "confirming";

  const confirm = useCallback(() => {
    if (busy || step === "done" || out.current !== null || ids.length === 0) return;
    void runConfirm({ shown: ids, entries: group.entries, terms: group.terms, wallet }, deps, onEvent, (sent) => {
      out.current = sent;
    }).catch(failed);
  }, [busy, deps, failed, group.entries, group.terms, ids, onEvent, step, wallet]);

  const recheck = useCallback(() => {
    const sent = out.current;
    if (busy || sent === null) return;
    setStep("confirming");
    void lookForReceipt(sent, wallet, deps, onEvent).catch(failed);
  }, [busy, deps, failed, onEvent, wallet]);

  return { step, rows, failure, txHash, actions: { confirm, recheck } };
}
