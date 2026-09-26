import { BaseError, type Hex } from "viem";
import { decodeRegistryError } from "@/lib/chain/calldata";
import { DigestMismatch } from "@/lib/chain/digest";
import { revertCopy } from "@/lib/chain/reverts";
import { Reverted } from "@/lib/chain/watch";
import { isUserCancellation } from "@/lib/errors/cancelled";
import { explainPasskeyError } from "@/lib/passkey/browser";
import type { AuthProblem } from "@/lib/passkey/verify";
import { VerifierError } from "@/lib/verifier/client";
import { ConfirmTimeout } from "./confirm";

/**
 * One failure, turned into the line the screen prints and the one thing the
 * creator can do about it.
 *
 * The key names a string under "studio.failure" in every message file, so every
 * failure is translated rather than leaking an English exception onto a Tamil
 * screen. The reason field carries the service's or the browser's own words,
 * which the copy prints after the sentence.
 *
 * What a failure is allowed to offer depends on where it happened, and the
 * caller says where rather than the error's name being guessed at. Before the
 * send, a second attempt costs nothing. After it, the transaction may already
 * be on chain and the only honest offer is to ask Monad again.
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

/**
 * Which phase of a flow threw.
 *
 * "sign" covers the chain read that builds the digest and the passkey ceremony
 * over it. "send" ends the moment the wallet answers; everything after that is
 * "confirm", where nothing may be sent a second time.
 */
export type Stage = "prepare" | "sign" | "send" | "confirm";

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
 *
 * The two sealed refusals both mean the same thing to the creator: nothing was pinned, nothing was
 * registered, and trying again costs them the upload. What the service could not do with the
 * record or the file is its own fault to fix and stays in its log.
 */
const VERIFIER_KEYS: Record<string, { key: string; next?: Failure["next"]; quiet?: boolean }> = {
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
  // The service's own words on these two are a full sentence saying what was
  // not done, in English. The line above already says it in the reader's
  // language, so repeating it underneath would only be saying it twice.
  "sealed-metadata-refused": { key: "sealedRecordRefused", next: "again", quiet: true },
  "sealed-file-refused": { key: "sealedFileRefused", next: "again", quiet: true },
  "bad-request": { key: "badRequest" },
  "bad-response": { key: "badResponse", next: "again" },
};

/**
 * The four refusals a private re-check has of its own, read off the service's
 * word in the body because each shares its status with other answers.
 *
 * Every one of them means nothing was pinned and nothing was registered. The
 * service's words are English and only restate the code, so none is printed
 * under the sentence. Only an unreachable chain is worth trying again as it
 * stands; the others would refuse the same request the same way, so their
 * sentence says what to change instead. A published picture can be refused for
 * its thumbnail too, and the same sentence is true for it: sealed with the
 * private re-check off makes no thumbnail at all.
 */
const PRIVATE_RECHECK_KEYS: Record<string, { key: string; next?: Failure["next"] }> = {
  "private-recheck-needs-sealed": { key: "privateRecheckNeedsSealed" },
  "private-copy-not-private": { key: "privateCopyNotPrivate" },
  "chain-unreachable": { key: "privateChainUnreachable", next: "again" },
  "thumbnail-too-large": { key: "privateThumbnailTooLarge" },
};

/**
 * A refusal about the picture itself, named in the body: the same picture would be refused again.
 *
 * `signed-file-too-large` shares its 413 with an upload that was over the limit when it arrived,
 * and the plain size sentence would be untrue for it: the chosen file was under 20 MB and only the
 * signed copy grew past it.
 */
const PICTURE_KEYS: Record<string, { key: string }> = {
  "fingerprint-unstable": { key: "fingerprintUnstable" },
  "signed-file-too-large": { key: "signedFileTooLarge" },
};

/**
 * The refusals that happened before a byte left the wallet, so the same signed
 * bytes can go out again with no second passkey prompt.
 */
const RESENDABLE = new Set(["sendCancelled", "sponsorship"]);

export function isResendable(failure: Failure | null): boolean {
  return failure !== null && RESENDABLE.has(failure.key);
}

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

export function describeFailure(error: unknown, stage: Stage, wallet?: Hex): Failure {
  if (error instanceof ConfirmTimeout) {
    return { key: "confirmPending", next: "recheck", address: wallet ?? error.wallet };
  }

  if (error instanceof VerifierError) {
    const own = PRIVATE_RECHECK_KEYS[error.serviceCode ?? ""] ?? PICTURE_KEYS[error.serviceCode ?? ""];
    if (own !== undefined) {
      return { ...own };
    }
    const mapped = VERIFIER_KEYS[error.code] ?? { key: "badResponse", next: "again" as const };
    // Some failures are named in the body and nothing more, so printing the
    // service's word under the sentence would only repeat the code back.
    const { quiet, ...copy } = mapped;
    const named = quiet === true || error.message === error.code ? { ...copy } : { ...copy, reason: error.message };
    // The duplicate answer carries the passport that already holds the picture, so the screen can
    // send the reader there instead of leaving them with a dead end.
    return error.passportId === undefined ? named : { ...named, passportId: error.passportId };
  }

  if (error instanceof AuthCheckFailed) {
    return { key: "authCheck", reason: error.message, next: "again" };
  }

  if (error instanceof DigestMismatch) {
    // Nothing was signed and nothing was sent: the registry described a
    // different record than the one this page built, and the two have to agree
    // before a passkey is touched.
    return { key: "digestMismatch", reason: error.message };
  }

  if (stage === "sign") {
    return signingFailure(error);
  }

  if (stage === "send") {
    return sendingFailure(error);
  }

  if (stage === "confirm") {
    return watchingFailure(error, wallet);
  }

  return { key: "unknown", reason: messageOf(error), next: "again" };
}

/**
 * The digest read and the passkey ceremony share a phase, and they fail in
 * completely different ways. Anything viem raised came from the chain read, so
 * it is a network problem with nothing signed behind it. Everything else in
 * this phase came out of the ceremony.
 */
function signingFailure(error: unknown): Failure {
  if (error instanceof BaseError) {
    return { key: "sendFailed", reason: messageOf(error), next: "again" };
  }

  const problem = explainPasskeyError(error);
  const keys = { cancelled: "passkeyCancelled", origin: "passkeyOrigin", unsupported: "passkeyUnsupported" } as const;
  const key = problem.code === "other" ? "passkeyOther" : keys[problem.code];
  return { key, reason: problem.message, next: problem.code === "cancelled" ? "again" : undefined };
}

/** Up to and including the wallet's answer. Nothing is on chain yet, so a second attempt is safe. */
function sendingFailure(error: unknown): Failure {
  const revert = decodeRegistryError(error);
  if (revert !== undefined) {
    const copy = revertCopy(revert);
    // A revert wrote nothing, and a new drawing would still spend a slot from
    // the day's quota. The panel's own button is there for anyone who wants
    // that; this note does not push them into it.
    return { key: copy.key, reason: revert, next: copy.next === "generateAgain" ? undefined : copy.next };
  }
  if (isSponsorshipRefusal(error)) {
    return { key: "sponsorship", reason: messageOf(error), next: "unsponsored" };
  }
  if (isUserCancellation(error)) {
    return { key: "sendCancelled", next: "again" };
  }
  return { key: "sendFailed", reason: messageOf(error), next: "again" };
}

/**
 * After the wallet answered. The transaction is out of this screen's hands, so
 * every failure here is a question for Monad and never an offer to send again.
 * The one exception is a receipt that came back mined and reverted: that is the
 * chain saying plainly that nothing was written.
 */
function watchingFailure(error: unknown, wallet?: Hex): Failure {
  if (error instanceof Reverted) {
    return { key: "reverted", reason: messageOf(error), next: "again" };
  }
  return { key: "confirmPending", reason: messageOf(error), next: "recheck", address: wallet };
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
