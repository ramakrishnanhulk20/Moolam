import type { Hex } from "viem";
import { isUserCancellation } from "@/lib/errors/cancelled";
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
  next?: "grant" | "again" | "recheck" | "signIn" | "later" | "openPassport";
  /** The passport the "openPassport" button opens: the one that already holds this picture. */
  passportId?: Hex;
}

/**
 * A send that is out and a send that failed look the same to a reducer and must never look the
 * same to a reader. Both of these were accepted somewhere, so the panel prints them in the muted
 * ink and offers a second look at the chain rather than a second send.
 */
export function isEditPending(failure: EditFailure | null): boolean {
  return failure !== null && (failure.key === "confirmPending" || failure.key === "sendPending");
}

export interface EditState {
  file: File | null;
  title: string;
  note: string;
  steps: Record<EditStep, StepState>;
  /** The service's answer: the child passport, its pins and its transaction hash. */
  result: EditResponse | null;
  block: bigint | null;
  /** The parent's newest edits as the chain lists them once the child landed, newest first. */
  children: Hex[] | null;
  /** How many edits the parent has in all, which is more than the page above can hold. */
  total: number | null;
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
  | { type: "watching" }
  | { type: "confirmed"; block: bigint | null; children: Hex[] | null; total: number | null }
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
  total: null,
  quota: null,
  confirming: false,
  failure: null,
};

/** Every move the panel can make, in one place, so the steps and the receipt read the same state. */
export function editReducer(state: EditState, action: EditAction): EditState {
  switch (action.type) {
    case "choose":
      // An edit that may be on the network keeps its warning and its re-check while a new picture
      // is chosen. Clearing them here is what used to offer a second send for an edit that landed.
      return isEditOutstanding(state)
        ? { ...state, file: action.file }
        : { ...initialEditState, file: action.file, title: state.title, note: state.note, quota: state.quota };
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
    case "watching":
      // The wait is running again, so the panel is busy for the whole of it and the warning that
      // started this comes back only if the chain still has not shown the edit at the end.
      return { ...state, failure: null, confirming: true, steps: { pin: "done", send: "running" } };
    case "confirmed":
      return {
        ...state,
        block: action.block,
        children: action.children,
        total: action.total,
        confirming: false,
        failure: null,
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

/**
 * Whether an edit from this panel may be out on the network.
 *
 * True while the chain is being watched, and true afterwards for as long as the answer is "it may
 * still land". The panel refuses a second send the whole time, because the one thing worse than an
 * edit nobody can see is two of them.
 */
export function isEditOutstanding(state: EditState): boolean {
  return state.confirming || isEditPending(state.failure);
}

export function isEditDone(state: EditState): boolean {
  return state.steps.send === "done";
}

/** Which line under "passport.edit.failure" a file the browser refuses gets. */
const UPLOAD_KEYS: Record<RefusalCode, string> = {
  "too-large": "tooLarge",
  "not-an-image": "notAnImage",
  empty: "empty",
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
 *
 * `send-pending` is the dangerous one. Privy took the transaction and the chain had not shown it
 * inside the service's wait, so it may still land and the only safe offer is to look again. The
 * two `unavailable` answers are the opposite: a dependency never answered and nothing was sent,
 * so waiting a moment and sending again costs nothing.
 */
const SERVICE_KEYS: Record<string, { key: string; next?: EditFailure["next"] }> = {
  "no-signer": { key: "noSigner", next: "grant" },
  "send-pending": { key: "sendPending", next: "recheck" },
  "privy-unavailable": { key: "dependencyDown", next: "later" },
  "chain-unavailable": { key: "dependencyDown", next: "later" },
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
  "already-registered": { key: "alreadyRegistered", next: "openPassport" },
};

/**
 * The refusals about the picture itself, read off the service's word in the body because the
 * status alone says too little: a 422 would read as an answer this app does not know, and a 413
 * would say the chosen file was over 20 MB when it was only the signed copy that grew past it.
 *
 * Each one pinned nothing and sent nothing, and the same file would be refused the same way, so
 * none offers a retry. The service's English only restates the sentence, so it is not printed.
 */
const PICTURE_KEYS: Record<string, { key: string }> = {
  "fingerprint-unstable": { key: "fingerprintUnstable" },
  "signed-file-too-large": { key: "signedFileTooLarge" },
  "thumbnail-too-large": { key: "thumbnailTooLarge" },
};

/**
 * The line for an edit that may be on the network: never a retry, always a second look.
 *
 * ConfirmTimeout says exactly this in its own words, so it is not repeated under the sentence.
 * Anything else that goes wrong after the send is worth printing: an RPC that dropped, a receipt
 * that came back reverted, an answer this app could not read.
 */
function stillOut(error: unknown): EditFailure {
  return error instanceof ConfirmTimeout
    ? { key: "confirmPending", next: "recheck" }
    : { key: "confirmPending", reason: messageOf(error), next: "recheck" };
}

/**
 * Whether this failure leaves the edit possibly on chain.
 *
 * The service names every refusal it raises itself, and those names are the truth: `pin-failed`
 * happened before the send, `no-signer` before anything at all. Silence is the other case. A fetch
 * that never got an answer, an edge that returned 502 with an HTML page, a body this app could not
 * read: the request may have reached the service, the service may have sent the transaction, and
 * the words "nothing was sent" would be a guess.
 */
function mayBeOut(error: VerifierError): boolean {
  if (error.named) {
    return false;
  }
  // Status 0 is a fetch that rejected. 5xx with no word of its own is an edge, not the service. A
  // 2xx here is an answer that arrived and did not parse, which is a send that happened.
  return error.status === 0 || error.status >= 500 || (error.status >= 200 && error.status < 300);
}

/**
 * One failure from the edit request, turned into the line the panel prints.
 *
 * `sent` is what the caller knows that the error does not: the service already answered with a
 * transaction, so this failure came out of the wait that followed and can never be a retry.
 */
export function describeEditFailure(error: unknown, { sent = false }: { sent?: boolean } = {}): EditFailure {
  if (sent || error instanceof ConfirmTimeout) {
    return stillOut(error);
  }
  if (error instanceof VerifierError) {
    if (mayBeOut(error)) {
      return stillOut(error);
    }
    const picture = PICTURE_KEYS[error.serviceCode ?? ""];
    if (picture !== undefined) {
      return { ...picture };
    }
    const mapped = SERVICE_KEYS[error.code] ?? { key: "badResponse", next: "again" as const };
    const passportId = error.passportId === undefined ? {} : { passportId: error.passportId };
    // Several failures are named in the body and nothing else, so printing the service's word
    // under the sentence would only repeat the code back at the reader.
    return error.message === error.code
      ? { ...mapped, ...passportId }
      : { ...mapped, ...passportId, reason: error.message };
  }
  // Only what went wrong before the request did: a session with no token, a file that cannot be
  // read. Everything after the send is one of the two branches above.
  return { key: "unknown", reason: messageOf(error), next: "again" };
}

/** One failure from the grant or the revoke, which is Privy's own window and not the service. */
export function describeGrantFailure(error: unknown): EditFailure {
  if (isUserCancellation(error)) {
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
