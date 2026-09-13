import type { QuotaState } from "@/lib/verifier/client";
import type { Failure } from "./problems";

/**
 * The agent path's own rules: what a prompt may be, how long both signatures
 * stay good for, and what the quota allows. Everything else about the run, the
 * steps, the sending and the waiting, is the upload path's and is shared.
 */

/** The service refuses anything outside this, so the box does too, before a request is spent. */
export const PROMPT_MIN = 8;
export const PROMPT_MAX = 600;

/**
 * How long the agent's signature and the creator's are good for.
 *
 * The agent signs first and the creator's passkey comes minutes later, so the
 * window has to cover a person reading the picture and deciding. Past it the
 * registry reverts with SignatureExpired and the screen offers to make it
 * again, which is honest: the old picture was never registered.
 */
export const DEADLINE_SECONDS = 30 * 60;

/** The three prompts offered as buttons. Their words live in the message files. */
export const EXAMPLE_PROMPTS = ["one", "two", "three"] as const;

/** Unix seconds the service is asked to sign against. */
export function generateDeadline(now: number = Date.now()): bigint {
  return BigInt(Math.floor(now / 1000) + DEADLINE_SECONDS);
}

/** What is wrong with the typed prompt, before a picture is paid for. */
export function checkPrompt(prompt: string): Failure | null {
  const trimmed = prompt.trim();
  if (trimmed.length < PROMPT_MIN) {
    return { key: "promptTooShort" };
  }
  if (trimmed.length > PROMPT_MAX) {
    return { key: "promptTooLong" };
  }
  return null;
}

/** Whether today's pictures are used up. A quota nobody has asked for yet allows the first one. */
export function atLimit(quota: QuotaState | null): boolean {
  return quota !== null && quota.used >= quota.limit;
}

/**
 * The same failure, with the retry named for what it would actually do.
 *
 * Trying again on the agent path is not resending the same picture: it draws a
 * new one and spends a slot from the day's quota, so the button says so.
 */
export function asGenerateFailure(failure: Failure): Failure {
  return failure.next === "again" ? { ...failure, next: "generateAgain" } : failure;
}
