import type { Hex } from "viem";
import type { GenerateResponse, PrepareResponse, QuotaState } from "@/lib/verifier/client";
import { checkImage as checkUpload, type RefusalCode } from "@/lib/upload/checkImage";
import { asGenerateFailure } from "./generate";
import type { Failure, Stage } from "./problems";

/**
 * The honest steps between a picture and a passport, and where the creator is
 * in them.
 *
 * The screen never invents a step it did not run: every row here is one thing
 * that actually happens, and a row only reads done once its answer is in hand.
 * The upload path runs three. The agent path runs five, and its first three
 * land together because the service draws, pins and signs inside one answer.
 */
export type Step = "prepare" | "draw" | "pin" | "agentSign" | "sign" | "send";

/**
 * "unconfirmed" is its own state on purpose: the send was accepted and Monad
 * has not shown it yet. It is not a failure, and the screens that treat it as
 * one invite a second send for a write that may already be on chain.
 */
export type StepState = "waiting" | "running" | "done" | "failed" | "unconfirmed";

/** Which way this picture is being made: the creator's file, or the agent's. */
export type Mode = "upload" | "generate";

export const STEPS: readonly Step[] = ["prepare", "sign", "send"];
export const GENERATE_STEPS: readonly Step[] = ["draw", "pin", "agentSign", "sign", "send"];

const ALL_STEPS: readonly Step[] = ["prepare", "draw", "pin", "agentSign", "sign", "send"];

/**
 * What the browser measured about one send, stamped only once Monad has
 * actually answered. Both ends are taken in useStudio: nothing here is a
 * constant and nothing is an estimate.
 */
export interface Timing {
  /** From handing the send to Privy to the confirm resolving, in milliseconds. */
  waitedMs: number;
  /**
   * From the tap to the second the confirmed block carries, in milliseconds.
   * Null when the block is not later than the tap, which is what a block sealed
   * inside the same second reads as.
   */
  sealedAfterMs: number | null;
}

/** What the transaction's own receipt was billed. Monad bills the limit, so this is the charge. */
export interface Charge {
  gasUsed: bigint;
  gasPrice: bigint;
}

/**
 * The two ends of the wait, turned into the figures the receipt prints.
 *
 * Kept here, away from the clock, so a test can hand it four numbers and read
 * the answer rather than trying to pin down performance.now in a browser.
 */
export function measure({
  handedAt,
  answeredAt,
  tappedAt,
  sealedAt,
}: {
  /** performance.now() where the send went to Privy. */
  handedAt: number;
  /** performance.now() where the confirm resolved. */
  answeredAt: number;
  /** Date.now() at the same moment the send went out, which is the reader's own clock. */
  tappedAt: number;
  /** The confirmed block's second, in milliseconds, or undefined when the chain gave none. */
  sealedAt: number | undefined;
}): Timing {
  const sealed = sealedAt === undefined ? null : sealedAt - tappedAt;
  return {
    waitedMs: Math.max(0, Math.round(answeredAt - handedAt)),
    sealedAfterMs: sealed !== null && sealed > 0 ? sealed : null,
  };
}

export interface RegisterState {
  mode: Mode;
  file: File | null;
  title: string;
  prompt: string;
  steps: Record<Step, StepState>;
  prepared: PrepareResponse | null;
  /** The agent's answer, whole: its signature, the model that drew, and the quota. Only on the agent path. */
  generated: GenerateResponse | null;
  /** What this creator has spent today, kept across a refusal so the panel can still show it. */
  quota: QuotaState | null;
  digest: Hex | null;
  txHash: Hex | null;
  block: bigint | null;
  registeredAt: number | null;
  /** How long this send took, measured in this browser. Null until Monad has answered. */
  timing: Timing | null;
  /** What the send's receipt was billed. Null when the receipt could not be read. */
  charge: Charge | null;
  /** True while the send is out and the screen is watching Monad for the passport. */
  confirming: boolean;
  /** True once the creator has chosen to pay the fee from their own balance. */
  unsponsored: boolean;
  failure: Failure | null;
}

export type RegisterAction =
  | { type: "mode"; mode: Mode }
  | { type: "choose"; file: File }
  | { type: "title"; title: string }
  | { type: "prompt"; prompt: string }
  | { type: "start"; step: Step; unsponsored?: boolean }
  | { type: "prepared"; prepared: PrepareResponse }
  | { type: "drawn"; response: GenerateResponse }
  | { type: "signed"; digest: Hex }
  | { type: "sent"; txHash: Hex }
  | { type: "watching" }
  | { type: "confirmed"; block: bigint | null; at: number; timing?: Timing; charge?: Charge }
  | { type: "failed"; failure: Failure; quota?: QuotaState; stage?: Stage }
  | { type: "reset" };

const WAITING: Record<Step, StepState> = {
  prepare: "waiting",
  draw: "waiting",
  pin: "waiting",
  agentSign: "waiting",
  sign: "waiting",
  send: "waiting",
};

export const initialRegisterState: RegisterState = {
  mode: "upload",
  file: null,
  title: "",
  prompt: "",
  steps: WAITING,
  prepared: null,
  generated: null,
  quota: null,
  digest: null,
  txHash: null,
  block: null,
  registeredAt: null,
  timing: null,
  charge: null,
  confirming: false,
  unsponsored: false,
  failure: null,
};

/**
 * Every move the register screen can make, in one place, so the buttons and the
 * receipt column read the same state rather than each keeping their own.
 */
export function registerReducer(state: RegisterState, action: RegisterAction): RegisterState {
  switch (action.type) {
    case "mode":
      // Switching sides starts a clean run. What was typed for the other one is
      // kept, so a creator who looks at both does not lose their title.
      return {
        ...initialRegisterState,
        mode: action.mode,
        title: state.title,
        prompt: state.prompt,
        quota: state.quota,
      };
    case "choose":
      return {
        ...initialRegisterState,
        mode: state.mode,
        file: action.file,
        title: state.title,
        prompt: state.prompt,
        quota: state.quota,
      };
    case "title":
      return { ...state, title: action.title };
    case "prompt":
      return { ...state, prompt: action.prompt };
    case "start":
      return {
        ...state,
        failure: null,
        confirming: false,
        unsponsored: action.unsponsored ?? state.unsponsored,
        steps: { ...state.steps, [action.step]: "running" },
      };
    case "prepared":
      return { ...state, prepared: action.prepared, steps: { ...state.steps, prepare: "done" } };
    case "drawn":
      // One answer carries all three: the picture, the pins and the agent's
      // signature over the pinned bytes. They stamp together because that is
      // when they became true.
      return {
        ...state,
        prepared: action.response,
        generated: action.response,
        quota: action.response.quota,
        steps: { ...state.steps, draw: "done", pin: "done", agentSign: "done" },
      };
    case "signed":
      return { ...state, digest: action.digest, steps: { ...state.steps, sign: "done" } };
    case "sent":
      return { ...state, txHash: action.txHash };
    case "watching":
      return { ...state, confirming: true, failure: null, steps: { ...state.steps, send: "running" } };
    case "confirmed":
      return {
        ...state,
        block: action.block,
        registeredAt: action.at,
        timing: action.timing ?? state.timing,
        charge: action.charge ?? state.charge,
        confirming: false,
        steps: { ...state.steps, send: "done" },
      };
    case "failed":
      return {
        ...state,
        confirming: false,
        // A retry before the send draws a new picture on the agent path, so the
        // button that offers it is named for that. After the send there is
        // nothing to draw again, only a chain to ask.
        failure: state.mode === "generate" ? asGenerateFailure(action.failure, action.stage) : action.failure,
        quota: action.quota ?? state.quota,
        steps: markRunning(state.steps, action.failure.key === "confirmPending" ? "unconfirmed" : "failed"),
      };
    case "reset":
      return { ...initialRegisterState, mode: state.mode, quota: state.quota };
  }
}

/** Which line under "studio.failure" a refused file gets. */
const UPLOAD_KEYS: Record<RefusalCode, string> = {
  "too-large": "tooLarge",
  "not-an-image": "notAnImage",
};

/**
 * What is wrong with a chosen file, before a byte leaves the machine.
 *
 * The size and type test is the shared one in lib/upload, so the studio, the
 * story's try panel and the verify page refuse the same files. Only the message
 * key is the studio's own.
 */
export function checkImage(file: File): Failure | null {
  const refusal = checkUpload(file);
  return refusal === null ? null : { key: UPLOAD_KEYS[refusal.code], reason: refusal.reason };
}

export function isRegistered(state: RegisterState): boolean {
  return state.steps.send === "done";
}

/**
 * Whether the screen is holding a run. A step still waiting on Monad counts:
 * the watch is alive, a recheck can end it, and starting a second run would
 * send the same passport twice.
 */
export function isBusy(state: RegisterState): boolean {
  return ALL_STEPS.some((step) => state.steps[step] === "running" || state.steps[step] === "unconfirmed");
}

/** The send is out and Monad has not shown it. Nothing may be sent again from here. */
export function isUnconfirmed(state: RegisterState): boolean {
  return ALL_STEPS.some((step) => state.steps[step] === "unconfirmed");
}

/**
 * The passport id is the sha256 of the signed bytes, which is what prepare
 * handed back.
 *
 * A duplicate refused at prepare never gets that far: nothing was pinned and
 * nothing was prepared, and the only id in the room is the one the service named
 * in its refusal. Without it the "open that passport" button has nowhere to go.
 */
export function passportId(state: RegisterState): Hex | null {
  return state.prepared?.passport.exactHash ?? state.failure?.passportId ?? null;
}

function markRunning(steps: Record<Step, StepState>, to: StepState): Record<Step, StepState> {
  const next = { ...steps };
  for (const step of ALL_STEPS) {
    if (next[step] === "running") {
      next[step] = to;
    }
  }
  return next;
}
