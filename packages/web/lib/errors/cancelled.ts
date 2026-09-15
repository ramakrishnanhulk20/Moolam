/**
 * Whether a person closed a prompt themselves.
 *
 * Three screens were each carrying their own copy of this test and they had
 * drifted apart, so the same closed window read as "you cancelled" on one
 * screen and "something went wrong" on another. One predicate now, because a
 * cancellation is not a failure to apologise for and never gets an error tone.
 *
 * The wording comes from what the wallet layer actually throws. EIP-1193 says
 * a rejected request carries code 4001, and viem raises
 * UserRejectedRequestError with it. Privy throws by message instead: its
 * modal watcher rejects with "User rejected request" the moment the popup is
 * closed, its provider raises "The user rejected the request", and its own
 * flows say "User canceled flow", "User cancelled funding" and "User exited
 * before their wallet could be recovered". A WebAuthn prompt the person
 * dismisses arrives as a NotAllowedError instead, which is why the name is
 * matched as well.
 */

const WORDS =
  /\buser (rejected|denied|declined|cancell?ed|closed|exited)\b|rejected the request|\b(cancell?ed|aborted|dismissed)\b|(modal|popup|window|prompt) (was )?closed|closed the (modal|popup|window|prompt)/i;

export function isUserCancellation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 4001) {
    return true;
  }

  const name = (error as { name?: unknown } | null)?.name;
  if (name === "UserRejectedRequestError" || name === "NotAllowedError" || name === "AbortError") {
    return true;
  }

  return WORDS.test(messageOf(error));
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
