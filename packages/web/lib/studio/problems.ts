import type { Hex } from "viem";
import { decodeRegistryError } from "@/lib/chain/calldata";
import { explainPasskeyError } from "@/lib/passkey/browser";
import type { AuthProblem } from "@/lib/passkey/verify";
import { VerifierError } from "@/lib/verifier/client";
import { ConfirmTimeout } from "./confirm";

/**
 * One failure, turned into the line the screen prints and the one thing the
 * creator can do about it.
 *
 * The key names a string under "studio.failure" in both message files, so every
 * failure is translated rather than leaking an English exception onto a Tamil
 * screen. The reason field carries the service's or the browser's own words,
 * which the copy prints after the sentence.
 */
export interface Failure {
  key: string;
  reason?: string;
  /** The one button offered under the message. */
  next?: "signIn" | "signOut" | "bind" | "openPassport" | "unsponsored" | "again" | "generateAgain" | "recheck";
  /** An account to open on MonadVision, shown when the message asks the reader to go and look. */
  address?: Hex;
  /** The passport that already holds this picture, when the service named it before anything was pinned. */
  passportId?: Hex;
}

/** Which part of the flow threw, because the same DOMException means different things in each. */
export type Stage = "prepare" | "passkey" | "send";

/** A signature this browser already knows the registry would refuse, with the check that failed. */
export class AuthCheckFailed extends Error {
  readonly problem: AuthProblem;

  constructor(problem: AuthProblem, message: string) {
    super(message);
    this.name = "AuthCheckFailed";
    this.problem = problem;
  }
}

/**
 * Which sentence each answer from the service gets.
 *
 * `creator-mismatch` can only happen in the studio when the signed-in account changed under the
 * page, because the address on the request is the one this session read from Privy. A fresh sign
 * in is the only thing that fixes it, so that is what the copy asks for.
 *
 * `deadline-passed` means the picture was drawn and the window to sign it closed, so the slot is
 * spent and the honest offer is a new drawing with a new window.
 */
const VERIFIER_KEYS: Record<string, { key: string; next?: Failure["next"] }> = {
  offline: { key: "serviceOffline", next: "again" },
  "creator-mismatch": { key: "creatorMismatch", next: "signOut" },
  "deadline-passed": { key: "deadlinePassed", next: "again" },
  "already-registered": { key: "alreadyRegistered", next: "openPassport" },
  unauthorized: { key: "signedOut", next: "signIn" },
  "too-large": { key: "tooLarge" },
  "not-an-image": { key: "notAnImage" },
  "rate-limited": { key: "rateLimited" },
  quota: { key: "quotaReached" },
  "prompt-refused": { key: "promptRefused" },
  "model-failed": { key: "modelFailed", next: "again" },
  "sign-failed": { key: "agentSignFailed", next: "again" },
  busy: { key: "agentBusy", next: "again" },
  "pin-failed": { key: "pinFailed", next: "again" },
  "bad-request": { key: "badRequest" },
  "bad-response": { key: "badResponse", next: "again" },
};

const REVERT_KEYS: Record<string, { key: string; next?: Failure["next"] }> = {
  PassportAlreadyExists: { key: "alreadyRegistered", next: "openPassport" },
  SignatureExpired: { key: "expired", next: "again" },
  PasskeyNotBound: { key: "notBound", next: "bind" },
  InvalidPasskeySignature: { key: "badSignature", next: "again" },
  InvalidPublicKey: { key: "badKey", next: "bind" },
  EnforcedPause: { key: "paused" },
  InvalidCreator: { key: "wrongWallet" },
  EmptyMetadataURI: { key: "rejected" },
  InvalidExactHash: { key: "rejected" },
  InvalidKind: { key: "rejected" },
  InvalidFingerprintVersion: { key: "rejected" },
};

/**
 * Whether Privy refused to pay the network fee before the transaction was
 * submitted.
 *
 * Privy answers a spent or absent gas allowance with a message rather than a
 * code, so the words are what there is to match on. The match is loose because
 * a false positive only offers a second button. A wait that timed out is a
 * different thing entirely: the sponsored send may already have landed, so
 * sending it again would be the expensive mistake, and it never counts here.
 */
export function isSponsorshipRefusal(error: unknown): boolean {
  if (error instanceof ConfirmTimeout) {
    return false;
  }
  const text = messageOf(error).toLowerCase();
  return /sponsor|policy|paymaster|credit|not configured/.test(text);
}

/** Whether the person closed the wallet prompt themselves, which is not a failure to apologise for. */
function isUserRejection(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 4001) {
    return true;
  }
  return /user (rejected|denied|declined)|rejected the request|cancell?ed/i.test(messageOf(error));
}

export function describeFailure(error: unknown, stage: Stage, wallet?: Hex): Failure {
  if (error instanceof ConfirmTimeout) {
    return { key: "confirmPending", next: "recheck", address: wallet ?? error.wallet };
  }

  if (error instanceof VerifierError) {
    const mapped = VERIFIER_KEYS[error.code] ?? { key: "badResponse", next: "again" as const };
    // Some failures are named in the body and nothing more, so printing the
    // service's word under the sentence would only repeat the code back.
    const named = error.message === error.code ? { ...mapped } : { ...mapped, reason: error.message };
    // The duplicate answer carries the passport that already holds the picture, so the screen can
    // send the reader there instead of leaving them with a dead end.
    return error.passportId === undefined ? named : { ...named, passportId: error.passportId };
  }

  if (error instanceof AuthCheckFailed) {
    return { key: "authCheck", reason: error.message, next: "again" };
  }

  if (stage === "passkey") {
    const problem = explainPasskeyError(error);
    const keys = { cancelled: "passkeyCancelled", origin: "passkeyOrigin", unsupported: "passkeyUnsupported" } as const;
    const key = problem.code === "other" ? "passkeyOther" : keys[problem.code];
    return { key, reason: problem.message, next: problem.code === "cancelled" ? "again" : undefined };
  }

  if (stage === "send") {
    const revert = decodeRegistryError(error);
    if (revert !== undefined) {
      const mapped = REVERT_KEYS[revert] ?? { key: "reverted", next: "again" as const };
      return { ...mapped, reason: revert };
    }
    if (isSponsorshipRefusal(error)) {
      return { key: "sponsorship", reason: messageOf(error), next: "unsponsored" };
    }
    if (isUserRejection(error)) {
      return { key: "sendCancelled", next: "again" };
    }
    return { key: "sendFailed", reason: messageOf(error), next: "again" };
  }

  return { key: "unknown", reason: messageOf(error), next: "again" };
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
