import type { Hex } from "viem";
import { consentRevertCopy } from "@/lib/chain/reverts";
import { Reverted } from "@/lib/chain/watch";
import { isUserCancellation } from "@/lib/errors/cancelled";
import { ConfirmTimeout } from "@/lib/studio/confirm";
import { consentRevert } from "./call";

/** One failure, in the words the control prints and the one thing worth doing about it. */
export interface ConsentFailure {
  /** A string under "passport.consent.failure". */
  key: string;
  /** The chain's or the wallet's own words, printed under the sentence. */
  reason?: string;
  /** The single button offered under the message. */
  next?: "again" | "recheck" | "signIn";
  /** The account the write went from, for the "open it and look" link under a wait that ran out. */
  address?: Hex;
  /** When the register will take another statement from this wallet, for the line that names it. */
  at?: number;
}

/**
 * One failed statement, turned into the line the control prints.
 *
 * The register's own error is named first, because it is the most useful thing
 * anyone can be told: a holder who does not hold the passport any more, and one
 * who wrote three minutes ago, are two different problems with two different
 * answers. A wait that ran out is never a failed send.
 */
export function describeConsentFailure(error: unknown): ConsentFailure {
  if (error instanceof ConfirmTimeout) {
    return { key: "confirmPending", next: "recheck", address: error.wallet };
  }
  if (isUserCancellation(error)) {
    return { key: "declined", next: "again" };
  }
  if (error instanceof Reverted) {
    return { key: "reverted", reason: error.message, next: "again" };
  }

  const revert = consentRevert(error);
  if (revert !== undefined) {
    const copy = consentRevertCopy(revert.name);
    return {
      key: copy.key,
      reason: revert.name,
      next: copy.next === "again" ? "again" : undefined,
      // TooSoon carries the second the register opens again, which is a better
      // answer than "wait a while" and is the chain's own number.
      at: revert.name === "TooSoon" ? secondsFrom(revert.args[1]) : undefined,
    };
  }

  return { key: "unknown", reason: messageOf(error), next: "again" };
}

function secondsFrom(value: unknown): number | undefined {
  if (typeof value === "bigint") {
    return Number(value);
  }
  return typeof value === "number" ? value : undefined;
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
