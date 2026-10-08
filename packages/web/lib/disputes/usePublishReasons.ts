"use client";

import { useSendTransaction, useSignTypedData, useWallets } from "@privy-io/react-auth";
import { useCallback, useMemo, useRef, useState } from "react";
import { BaseError, ContractFunctionRevertedError, type Hex } from "viem";
import { CHAIN_ID, chain } from "@/lib/chain/client";
import { DisputeStatus, getDispute } from "@/lib/chain/registry";
import { headTimestamp } from "@/lib/chain/time";
import { isUserCancellation } from "@/lib/errors/cancelled";
import { refreshPassport } from "@/lib/passport/refresh";
import { transactionHash } from "@/lib/studio/confirm";
import { ensureMonad } from "@/lib/studio/wallet";
import { DECISIONS_ADDRESS } from "./decisionsContract";
import { PublishNotShown, PublishPending, confirmPublish, pinReasons } from "./publishReasons";
import {
  REASONS_SIGNATURE_SECONDS,
  REFUSAL_OF_REVERT,
  decisionsAbi,
  publishCalldata,
  reasonsHashOf,
  reasonsText,
  reasonsTextProblem,
  walletReasonsTypedData,
  type PublishRefusal,
} from "./reasons";

/**
 * Where one decision's publish stands. "pending" is a transaction that went
 * out and has not shown in a receipt: never a failure, and never sent again
 * from here; only "look again" moves it on.
 */
export type PublishPhase = "idle" | "signing" | "pinning" | "sending" | "confirming" | "pending" | "done";

export interface PublishState {
  text: string;
  phase: PublishPhase;
  refusal: PublishRefusal | null;
  reasonsURI?: string;
  hash?: Hex;
}

export interface PublishDesk {
  /** Each passport's step, by its lower-case id. A passport not in here has not been touched. */
  steps: Record<string, PublishState>;
  setText: (passportId: Hex, text: string) => void;
  publish: (passportId: Hex) => Promise<void>;
  /** Looks again for a publish that went out. Sends nothing. */
  recheck: (passportId: Hex) => Promise<void>;
}

export const IDLE_STEP: PublishState = { text: "", phase: "idle", refusal: null };

/** The out-of-flight transaction a recheck looks for again. */
interface Watch {
  hash?: Hex;
  openedAt: bigint;
  reasonsURI: string;
  fromBlock: bigint;
}

function revertName(error: unknown): string | undefined {
  if (!(error instanceof BaseError)) return undefined;
  const reverted = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
  return reverted instanceof ContractFunctionRevertedError ? reverted.data?.errorName : undefined;
}

/**
 * The resolver's publish step, after a resolve: write the reasons, have the
 * resolver's wallet sign them, pin them through the verify service, then name
 * the pinned address in MoolamDecisions.publish from the same wallet.
 *
 * Which way the decision went and which dispute it was are read from the
 * registry at the moment of the press, never taken from the button that settled
 * it. The publish is called done only from the DecisionPublished event in its
 * receipt.
 */
export function usePublishReasons(): PublishDesk {
  const { wallets } = useWallets();
  const { signTypedData } = useSignTypedData();
  const { sendTransaction } = useSendTransaction();
  const embedded = useMemo(() => wallets.find((entry) => entry.walletClientType === "privy"), [wallets]);
  const wallet = embedded?.address as Hex | undefined;

  const [steps, setSteps] = useState<Record<string, PublishState>>({});
  const watches = useRef(new Map<string, Watch>());

  const update = useCallback((passportId: Hex, change: Partial<PublishState>) => {
    const key = passportId.toLowerCase();
    setSteps((all) => ({ ...all, [key]: { ...(all[key] ?? IDLE_STEP), ...change } }));
  }, []);

  const watch = useCallback(
    async (passportId: Hex) => {
      const out = watches.current.get(passportId.toLowerCase());
      if (out === undefined) return;
      update(passportId, { phase: "confirming", refusal: null });
      try {
        const landed = await confirmPublish({ ...out, passportId });
        watches.current.delete(passportId.toLowerCase());
        // Before the screen says done, so anything that redraws on done reads the new decision.
        await refreshPassport(passportId).catch(() => undefined);
        update(passportId, { phase: "done", hash: landed.hash, reasonsURI: landed.published.reasonsURI });
      } catch (error) {
        if (error instanceof PublishPending) {
          update(passportId, { phase: "pending" });
          return;
        }
        watches.current.delete(passportId.toLowerCase());
        update(passportId, {
          phase: "idle",
          refusal: error instanceof PublishNotShown ? "reverted" : "unknown",
          hash: error instanceof PublishNotShown ? error.hash : undefined,
        });
      }
    },
    [update],
  );

  const publish = useCallback(
    async (passportId: Hex) => {
      const key = passportId.toLowerCase();
      const current = steps[key] ?? IDLE_STEP;
      if (embedded === undefined || wallet === undefined || current.phase !== "idle" || watches.current.has(key)) {
        return;
      }
      const reasons = reasonsText(current.text);
      const problem = reasonsTextProblem(reasons);
      if (problem !== null) {
        update(passportId, { refusal: problem });
        return;
      }

      update(passportId, { phase: "signing", refusal: null });
      const stop = (refusal: PublishRefusal) => update(passportId, { phase: "idle", refusal });

      let openedAt: bigint;
      let upheld: boolean;
      let deadline: bigint;
      try {
        const dispute = await getDispute(passportId);
        if (dispute === null || (dispute.status !== DisputeStatus.Upheld && dispute.status !== DisputeStatus.Rejected)) {
          stop("notSettled");
          return;
        }
        openedAt = dispute.openedAt;
        upheld = dispute.status === DisputeStatus.Upheld;
        const done = (await chain.readContract({
          address: DECISIONS_ADDRESS,
          abi: decisionsAbi,
          functionName: "published",
          args: [passportId, openedAt],
        })) as boolean;
        if (done) {
          stop("alreadyPublished");
          return;
        }
        deadline = (await headTimestamp()) + BigInt(REASONS_SIGNATURE_SECONDS);
      } catch {
        stop("chainUnreachable");
        return;
      }

      let signature: Hex;
      try {
        const signed = await signTypedData(
          walletReasonsTypedData({ passportId: key as Hex, openedAt, upheld, reasonsHash: reasonsHashOf(reasons), deadline }),
          { address: wallet },
        );
        signature = signed.signature as Hex;
      } catch (error) {
        stop(isUserCancellation(error) ? "declined" : "unknown");
        return;
      }

      update(passportId, { phase: "pinning" });
      const pinned = await pinReasons({
        passportId,
        openedAt: Number(openedAt),
        upheld,
        reasons,
        deadline: Number(deadline),
        signature,
      });
      if (!pinned.ok) {
        stop(pinned.refusal);
        return;
      }
      const { reasonsURI } = pinned;

      update(passportId, { phase: "sending", reasonsURI });
      let fromBlock: bigint;
      let hash: Hex | undefined;
      try {
        await ensureMonad(embedded);
        // A revert costs nothing here and comes back with the contract's own error name.
        await chain.simulateContract({
          address: DECISIONS_ADDRESS,
          abi: decisionsAbi,
          functionName: "publish",
          args: [passportId, reasonsURI],
          account: wallet,
        });
        fromBlock = await chain.getBlockNumber();
        const answer = await sendTransaction(
          { to: DECISIONS_ADDRESS, data: publishCalldata(passportId, reasonsURI), chainId: CHAIN_ID },
          // The wallet the call was simulated for, named out loud.
          { sponsor: true, address: wallet },
        );
        hash = transactionHash(answer.hash);
      } catch (error) {
        const name = revertName(error);
        stop(isUserCancellation(error) ? "declined" : (name === undefined ? undefined : REFUSAL_OF_REVERT[name]) ?? "unknown");
        return;
      }

      watches.current.set(key, { hash, openedAt, reasonsURI, fromBlock: fromBlock > 5n ? fromBlock - 5n : 0n });
      update(passportId, { hash });
      await watch(passportId);
    },
    [embedded, sendTransaction, signTypedData, steps, update, wallet, watch],
  );

  return {
    steps,
    setText: (passportId, text) => {
      const step = steps[passportId.toLowerCase()];
      update(passportId, step?.phase === "idle" || step === undefined ? { text, refusal: null } : {});
    },
    publish,
    recheck: watch,
  };
}
