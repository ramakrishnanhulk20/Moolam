import type { Hex } from "viem";
import type { Failure } from "./problems";

/**
 * Binding a passkey is three waits in a row, and each one is a different thing
 * to say: the device is making the key, the person has to touch the sensor, the
 * transaction is on its way to Monad.
 */
export type BindStage = "idle" | "creating" | "waiting" | "sending" | "bound";

export interface BindState {
  stage: BindStage;
  qx: Hex | null;
  qy: Hex | null;
  txHash: Hex | null;
  failure: Failure | null;
}

export type BindAction =
  | { type: "stage"; stage: Exclude<BindStage, "bound"> }
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
      return { ...state, stage: "idle", failure: action.failure };
    case "reset":
      return initialBindState;
  }
}
