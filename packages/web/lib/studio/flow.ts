import type { Hex } from "viem";
import type { PrepareResponse } from "@/lib/verifier/client";
import type { Failure } from "./problems";

/**
 * The three honest steps between a picture and a passport, and where the
 * creator is in them.
 *
 * The screen never invents a step it did not run: every row here is one thing
 * that actually happens, and a row only reads done once its answer is in hand.
 */
export type Step = "prepare" | "sign" | "send";
export type StepState = "waiting" | "running" | "done" | "failed";

export const STEPS: readonly Step[] = ["prepare", "sign", "send"];

export interface RegisterState {
  file: File | null;
  title: string;
  steps: Record<Step, StepState>;
  prepared: PrepareResponse | null;
  digest: Hex | null;
  txHash: Hex | null;
  block: bigint | null;
  registeredAt: number | null;
  /** True once the creator has chosen to pay the fee from their own balance. */
  unsponsored: boolean;
  failure: Failure | null;
}

export type RegisterAction =
  | { type: "choose"; file: File }
  | { type: "title"; title: string }
  | { type: "start"; step: Step; unsponsored?: boolean }
  | { type: "prepared"; prepared: PrepareResponse }
  | { type: "signed"; digest: Hex }
  | { type: "sent"; txHash: Hex }
  | { type: "confirmed"; block: bigint; at: number }
  | { type: "failed"; failure: Failure }
  | { type: "reset" };

export const initialRegisterState: RegisterState = {
  file: null,
  title: "",
  steps: { prepare: "waiting", sign: "waiting", send: "waiting" },
  prepared: null,
  digest: null,
  txHash: null,
  block: null,
  registeredAt: null,
  unsponsored: false,
  failure: null,
};

/**
 * Every move the register screen can make, in one place, so the buttons and the
 * receipt column read the same state rather than each keeping their own.
 */
export function registerReducer(state: RegisterState, action: RegisterAction): RegisterState {
  switch (action.type) {
    case "choose":
      return { ...initialRegisterState, file: action.file, title: state.title };
    case "title":
      return { ...state, title: action.title };
    case "start":
      return {
        ...state,
        failure: null,
        unsponsored: action.unsponsored ?? state.unsponsored,
        steps: { ...state.steps, [action.step]: "running" },
      };
    case "prepared":
      return { ...state, prepared: action.prepared, steps: { ...state.steps, prepare: "done" } };
    case "signed":
      return { ...state, digest: action.digest, steps: { ...state.steps, sign: "done" } };
    case "sent":
      return { ...state, txHash: action.txHash };
    case "confirmed":
      return {
        ...state,
        block: action.block,
        registeredAt: action.at,
        steps: { ...state.steps, send: "done" },
      };
    case "failed":
      return { ...state, failure: action.failure, steps: markRunningFailed(state.steps) };
    case "reset":
      return initialRegisterState;
  }
}

/** The verify service refuses anything larger, so the browser says so first rather than uploading it. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

/**
 * What is wrong with a chosen file, before a byte leaves the machine.
 *
 * The service checks the same two things and its answer is still the one that
 * counts, but a creator should not spend a 40 MB upload to be told the limit.
 */
export function checkImage(file: File): Failure | null {
  if (!IMAGE_TYPES.includes(file.type)) {
    return { key: "notAnImage", reason: file.type === "" ? file.name : file.type };
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return { key: "tooLarge", reason: `${(file.size / 1_000_000).toFixed(1)} MB` };
  }
  return null;
}

export function isRegistered(state: RegisterState): boolean {
  return state.steps.send === "done";
}

export function isBusy(state: RegisterState): boolean {
  return STEPS.some((step) => state.steps[step] === "running");
}

/** The passport id is the sha256 of the signed bytes, which is what prepare handed back. */
export function passportId(state: RegisterState): Hex | null {
  return state.prepared?.passport.exactHash ?? null;
}

function markRunningFailed(steps: Record<Step, StepState>): Record<Step, StepState> {
  const next = { ...steps };
  for (const step of STEPS) {
    if (next[step] === "running") {
      next[step] = "failed";
    }
  }
  return next;
}
