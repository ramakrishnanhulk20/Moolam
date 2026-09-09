import { decodeRegistryError } from "@/lib/chain/calldata";
import { explainPasskeyError } from "@/lib/passkey/browser";
import type { AuthProblem } from "@/lib/passkey/verify";
import { VerifierError } from "@/lib/verifier/client";

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
  next?: "signIn" | "bind" | "openPassport" | "unsponsored" | "again";
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

const VERIFIER_KEYS: Record<string, { key: string; next?: Failure["next"] }> = {
  offline: { key: "serviceOffline", next: "again" },
  unauthorized: { key: "signedOut", next: "signIn" },
  "too-large": { key: "tooLarge" },
  "not-an-image": { key: "notAnImage" },
  "rate-limited": { key: "rateLimited" },
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
 * Whether Privy refused to pay the network fee.
 *
 * Privy answers a spent or absent gas allowance with a message rather than a
 * code, so the words are what there is to match on. A false positive here only
 * offers the creator a second button, and a false negative would hide why the
 * transaction never left, so the match is deliberately loose.
 */
export function isSponsorshipRefusal(error: unknown): boolean {
  const text = messageOf(error).toLowerCase();
  return /sponsor|gas ?policy|paymaster|credit/.test(text);
}

/** Whether the person closed the wallet prompt themselves, which is not a failure to apologise for. */
function isUserRejection(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 4001) {
    return true;
  }
  return /user (rejected|denied|declined)|rejected the request|cancell?ed/i.test(messageOf(error));
}

export function describeFailure(error: unknown, stage: Stage): Failure {
  if (error instanceof VerifierError) {
    const mapped = VERIFIER_KEYS[error.code] ?? { key: "badResponse", next: "again" as const };
    return { ...mapped, reason: error.message };
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
