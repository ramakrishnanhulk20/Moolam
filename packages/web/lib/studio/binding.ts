import { useEffect, useState } from "react";
import type { Hex } from "viem";
import type { Failure } from "./problems";

/**
 * Where a signed in account's Monad wallet has got to.
 *
 * Privy answers "no wallets" in two situations that look the same from here:
 * while its wallet list is still loading, and on a first sign in while it is
 * still making the embedded wallet. Neither is a fault, so both read as the
 * account opening. Only a list that is ready and still empty after the grace
 * period is reported as missing.
 */
export type WalletState = "opening" | "ready" | "missing";

/** How long a ready, empty wallet list is given before it is called missing. Making the wallet takes a few seconds. */
export const WALLET_GRACE_MS = 15_000;

export function walletState({
  walletsReady,
  embedded,
  graceOver,
}: {
  walletsReady: boolean;
  /** True when the list holds the wallet Privy made for this person. */
  embedded: boolean;
  /** True once the list has been ready and empty for WALLET_GRACE_MS. */
  graceOver: boolean;
}): WalletState {
  if (!walletsReady) {
    return "opening";
  }
  if (embedded) {
    return "ready";
  }
  return graceOver ? "missing" : "opening";
}

/**
 * The same answer, with the grace period timed. The clock starts only once the
 * list is ready and empty for someone signed in, and starts again from zero if
 * that stops being true.
 */
export function useWalletState(signedIn: boolean, walletsReady: boolean, embedded: boolean): WalletState {
  const empty = signedIn && walletsReady && !embedded;
  const [overdue, setOverdue] = useState(false);
  const [wasEmpty, setWasEmpty] = useState(empty);
  if (wasEmpty !== empty) {
    setWasEmpty(empty);
    setOverdue(false);
  }

  useEffect(() => {
    if (!empty) {
      return;
    }
    const timer = setTimeout(() => setOverdue(true), WALLET_GRACE_MS);
    return () => clearTimeout(timer);
  }, [empty]);

  return walletState({ walletsReady, embedded, graceOver: empty && overdue });
}

/**
 * Binding a passkey is three waits in a row, and each one is a different thing
 * to say: the device is making the key, the person has to touch the sensor, the
 * transaction is on its way to Monad.
 *
 * "unconfirmed" is the fourth answer, and it is not a failure: the bind was
 * accepted and Monad has not shown it. The card stays locked there, because a
 * second bind over one that lands would replace the key this browser just made.
 */
export type BindStage = "idle" | "creating" | "waiting" | "sending" | "bound" | "unconfirmed";

export interface BindState {
  stage: BindStage;
  qx: Hex | null;
  qy: Hex | null;
  txHash: Hex | null;
  failure: Failure | null;
}

export type BindAction =
  | { type: "stage"; stage: Exclude<BindStage, "bound" | "unconfirmed"> }
  | { type: "created"; qx: Hex; qy: Hex }
  | { type: "sent"; txHash: Hex }
  | { type: "bound" }
  | { type: "failed"; failure: Failure }
  | { type: "reset" };

export const initialBindState: BindState = { stage: "idle", qx: null, qy: null, txHash: null, failure: null };

export function bindReducer(state: BindState, action: BindAction): BindState {
  switch (action.type) {
    case "stage":
      return { ...state, stage: action.stage, failure: null };
    case "created":
      return { ...state, qx: action.qx, qy: action.qy, stage: "waiting" };
    case "sent":
      return { ...state, txHash: action.txHash, stage: "sending" };
    case "bound":
      return { ...state, stage: "bound", failure: null };
    case "failed":
      // A bind that is still out keeps the card locked and shows the recheck.
      // Everything else goes back to the start so the button can be pressed.
      return {
        ...state,
        stage: action.failure.key === "confirmPending" ? "unconfirmed" : "idle",
        failure: action.failure,
      };
    case "reset":
      return initialBindState;
  }
}
