import type { Hex } from "viem";
import { checkImage as checkUpload, type RefusalCode } from "@/lib/upload/checkImage";
import { ConfirmTimeout } from "@/lib/studio/confirm";
import { VerifierError, type EditResponse, type QuotaState } from "@/lib/verifier/client";

/**
 * The two honest steps between an edited picture and a child passport, and where the owner is in
 * them.
 *
 * The browser sees one request, so it never claims more than it knows: while the request is out,
 * the picture is being pinned; when the answer comes back the send is already out with a hash on
 * it, and what is left is Monad showing the record.
 */
export type EditStep = "pin" | "send";
export type StepState = "waiting" | "running" | "done" | "failed";

export const EDIT_STEPS: readonly EditStep[] = ["pin", "send"];

/** The longest note the service will take, in characters. */
export const NOTE_LIMIT = 280;

/** One failure, in the words the panel prints and the one thing worth doing about it. */
export interface EditFailure {
  /** A string under "passport.edit.failure". */
  key: string;
  /** The service's or the browser's own words, printed under the sentence. */
  reason?: string;
  /** The single button offered under the message. */
  next?: "grant" | "again" | "recheck" | "signIn";
}

export interface EditState {
  file: File | null;
  title: string;
  note: string;
  steps: Record<EditStep, StepState>;
  /** The service's answer: the child passport, its pins and its transaction hash. */
  result: EditResponse | null;
  block: bigint | null;
  /** The parent's edits as the chain lists them once the child landed, so the tree can be redrawn. */
  children: Hex[] | null;
  /** What this account has spent on edits today, kept across a refusal so the panel can show it. */
  quota: QuotaState | null;
  /** True while the send is out and Monad is being watched for the child. */
  confirming: boolean;
  failure: EditFailure | null;
}

export type EditAction =
  | { type: "choose"; file: File }
  | { type: "title"; title: string }
  | { type: "note"; note: string }
  | { type: "start" }
  | { type: "pinned"; result: EditResponse }
  | { type: "confirmed"; block: bigint | null; children: Hex[] }
  | { type: "failed"; failure: EditFailure; stage: EditStep; quota?: QuotaState }
  | { type: "reset" };

export const initialEditState: EditState = {
  file: null,
  title: "",
  note: "",
  steps: { pin: "waiting", send: "waiting" },
  result: null,
  block: null,
  children: null,
  quota: null,
  confirming: false,
  failure: null,
};

/** Every move the panel can make, in one place, so the steps and the receipt read the same state. */
export function editReducer(state: EditState, action: EditAction): EditState {
  switch (action.type) {
    case "choose":
      return { ...initialEditState, file: action.file, title: state.title, note: state.note, quota: state.quota };
    case "title":
      return { ...state, title: action.title };
    case "note":
      return { ...state, note: action.note };
    case "start":
      return { ...state, failure: null, confirming: false, steps: { pin: "running", send: "waiting" } };
    case "pinned":
      // One answer settles both: the pins are done and the transaction is out with a hash on it.
      return {
        ...state,
        result: action.result,
        quota: action.result.quota,
        confirming: true,
        steps: { pin: "done", send: "running" },
      };
    case "confirmed":
      return {
        ...state,
        block: action.block,
        children: action.children,
        confirming: false,
        steps: { pin: "done", send: "done" },
      };
    case "failed":
      return {
        ...state,
        confirming: false,
        failure: action.failure,
        quota: action.quota ?? state.quota,
        steps:
          action.stage === "send"
            ? { pin: "done", send: "failed" }
            : { pin: "failed", send: state.steps.send === "waiting" ? "waiting" : "failed" },
      };
    case "reset":
      return { ...initialEditState, quota: state.quota };
  }
}

export function isEditBusy(state: EditState): boolean {
  return state.steps.pin === "running" || state.steps.send === "running";
}

export function isEditDone(state: EditState): boolean {
  return state.steps.send === "done";
}

/** Which line under "passport.edit.failure" a file the browser refuses gets. */
const UPLOAD_KEYS: Record<RefusalCode, string> = {
  "too-large": "tooLarge",
  "not-an-image": "notAnImage",
};

/**
 * What is wrong with the chosen picture, before a byte leaves the machine. The size and type test
 * is the shared one in lib/upload, so this panel refuses exactly what the studio and the verify
 * page refuse.
 */
export function checkEditImage(file: File): EditFailure | null {
  const refusal = checkUpload(file);
  return refusal === null ? null : { key: UPLOAD_KEYS[refusal.code], reason: refusal.reason };
}

/**
 * Which sentence each answer from the service gets.
 *
 * `no-signer` is the one that changes the screen rather than the message: the grant this panel
 * asked for is not on the wallet, or it is there without the policy, and either way the way out is
 * to grant it again.
 */
const SERVICE_KEYS: Record<string, { key: string; next?: EditFailure["next"] }> = {
  "no-signer": { key: "noSigner", next: "grant" },
  "not-owner": { key: "notOwner" },
  "no-parent": { key: "noParent" },
  quota: { key: "quota" },
  "send-failed": { key: "sendFailed", next: "again" },
  "sign-failed": { key: "signFailed", next: "again" },
  "pin-failed": { key: "pinFailed", next: "again" },
  busy: { key: "busy", next: "again" },
  offline: { key: "offline", next: "again" },
  unauthorized: { key: "signedOut", next: "signIn" },
  "too-large": { key: "tooLarge" },
  "not-an-image": { key: "notAnImage" },
  "rate-limited": { key: "rateLimited" },
  "bad-request": { key: "badRequest" },
  "bad-response": { key: "badResponse", next: "again" },
};

/** Whether the person closed Privy's own window rather than something going wrong. */
function wasDeclined(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 4001) {
    return true;
  }
  return /user (rejected|denied|declined)|rejected the request|cancell?ed|closed/i.test(messageOf(error));
}

/** One failure from the edit request, turned into the line the panel prints. */
export function describeEditFailure(error: unknown): EditFailure {
  if (error instanceof ConfirmTimeout) {
    return { key: "confirmPending", next: "recheck" };
  }
  if (error instanceof VerifierError) {
    const mapped = SERVICE_KEYS[error.code] ?? { key: "badResponse", next: "again" as const };
    // Several failures are named in the body and nothing else, so printing the service's word
    // under the sentence would only repeat the code back at the reader.
    return error.message === error.code ? { ...mapped } : { ...mapped, reason: error.message };
  }
  return { key: "unknown", reason: messageOf(error), next: "again" };
}

/** One failure from the grant or the revoke, which is Privy's own window and not the service. */
export function describeGrantFailure(error: unknown): EditFailure {
  if (wasDeclined(error)) {
    return { key: "grantDeclined", next: "grant" };
  }
  return { key: "grantFailed", reason: messageOf(error), next: "grant" };
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : String(error);
}
