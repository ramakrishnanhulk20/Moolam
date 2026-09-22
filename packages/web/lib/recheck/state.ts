import type { Hex } from "viem";
import { VerifierError, type RecheckRequested, type RecheckStatus } from "@/lib/verifier/client";

/**
 * What a reader is told about a re-check request, and how the control gets
 * from one of those to the next.
 *
 * All of it is pure on purpose. The hook beside this file owns the timers, the
 * fetches and the tab, and every decision it makes is made by a function here,
 * so the rules can be read and tested without a browser.
 */

/** How long the control waits between asks while a request is in flight. */
export const POLL_MS = 60_000;

/**
 * How many times it asks before it stops and hands the reader the button.
 *
 * Thirty asks a minute apart is half an hour of watching, which is longer than
 * a batch of re-checks takes. A page left open all night must not keep a
 * request going out every minute for ever.
 */
export const POLL_LIMIT = 30;

/** One thing that can go wrong, in the words the control prints under recheck.failure. */
export type RecheckFailureKey =
  | "noPassport"
  | "sealed"
  | "queueFull"
  | "rateLimited"
  | "notAnswering"
  | "unknown";

/**
 * Where this passport's re-check stands, from the reader's seat.
 *
 * "none" is nobody has asked, which is where the button lives. "refused" is
 * the request itself being turned down, and it is not the same thing as
 * "failed", which is a re-check that really ran and could not finish.
 */
export type RecheckState =
  | { kind: "none" }
  | { kind: "sending" }
  | { kind: "queued"; requestedAt: number; position?: number; already: boolean }
  | { kind: "running"; requestedAt?: number; startedAt?: number }
  | { kind: "done"; finishedAt?: number; reportTx?: Hex; matched?: boolean; distance?: number }
  | { kind: "failed"; reason?: string }
  | { kind: "refused"; key: RecheckFailureKey; reason?: string; canRetry: boolean };

export const idleRecheck: RecheckState = { kind: "none" };

/** True while the queue still owes this passport an answer, which is when the control keeps asking. */
export function isWatched(state: RecheckState): boolean {
  return state.kind === "queued" || state.kind === "running";
}

/**
 * How long to wait before asking again, or null for "do not ask".
 *
 * A hidden tab gets null rather than a timer that wakes every minute to decide
 * it has nothing to do, and the count is what stops a page left open for a week
 * from asking for ever.
 */
export function nextPollDelay(state: RecheckState, asked: number, visible: boolean): number | null {
  if (!isWatched(state) || !visible || asked >= POLL_LIMIT) {
    return null;
  }
  return POLL_MS;
}

/** True once the control has asked as often as it is going to and the rest is the reader's to press. */
export function pollsSpent(state: RecheckState, asked: number): boolean {
  return isWatched(state) && asked >= POLL_LIMIT;
}

/** What the mount read, and every read after it, turns into on the screen. */
export function stateFromStatus(status: RecheckStatus): RecheckState {
  switch (status.status) {
    case "none":
      return idleRecheck;
    case "pending":
      // Nothing here says who asked or where it sits in the line: the status
      // route carries neither, and a position invented on the page would be a
      // number nobody can check.
      return { kind: "queued", requestedAt: status.requestedAt ?? 0, already: false };
    case "running":
      return { kind: "running", requestedAt: status.requestedAt, startedAt: status.startedAt };
    case "done":
      return {
        kind: "done",
        finishedAt: status.finishedAt,
        reportTx: status.reportTx,
        matched: status.matched,
        distance: status.distance,
      };
    case "failed":
      return { kind: "failed", reason: status.reason };
  }
}

/** What the answer to a press turns into, which is the one state that knows its place in the line. */
export function stateFromRequest(answer: RecheckRequested): RecheckState {
  if (answer.status === "running") {
    return { kind: "running", requestedAt: answer.requestedAt };
  }
  if (answer.status === "done" || answer.status === "failed") {
    // The queue answers a press with the record it holds, and a record that
    // finished between the mount read and the press is worth saying as it is.
    return answer.status === "done" ? { kind: "done" } : { kind: "failed" };
  }
  return {
    kind: "queued",
    requestedAt: answer.requestedAt,
    // Zero is the route saying this one is not waiting in the line, so it is
    // dropped rather than printed as "position 0".
    position: answer.position === undefined || answer.position === 0 ? undefined : answer.position,
    already: answer.already === true,
  };
}

/**
 * Which sentence a refused request gets, read off the service's own word in the
 * body rather than off the status, because one status covers several words.
 *
 * The first two cannot happen from these screens: the passport is on the page
 * that is asking, and a sealed one is never offered the button. They have
 * sentences anyway, because a route that answers them is telling the truth
 * about something and a reader deserves it in words.
 */
const SERVICE_KEYS: Record<string, { key: RecheckFailureKey; canRetry: boolean }> = {
  "no-passport": { key: "noPassport", canRetry: false },
  sealed: { key: "sealed", canRetry: false },
  "queue-full": { key: "queueFull", canRetry: true },
};

const CODE_KEYS: Partial<Record<VerifierError["code"], { key: RecheckFailureKey; canRetry: boolean }>> = {
  "rate-limited": { key: "rateLimited", canRetry: true },
  offline: { key: "notAnswering", canRetry: true },
  // A service without the queue route answers 404 with words of its own, and a
  // proxy in front of it answers with a page. Both land here, and both mean the
  // same thing to a reader: nothing was queued, try again.
  "bad-response": { key: "notAnswering", canRetry: true },
};

export function describeRecheckFailure(error: unknown): Extract<RecheckState, { kind: "refused" }> {
  if (error instanceof VerifierError) {
    const mapped = SERVICE_KEYS[error.serviceCode ?? ""] ?? CODE_KEYS[error.code] ?? { key: "unknown" as const, canRetry: true };
    // Several refusals are named in the body and nothing else, so printing the
    // service's word under the sentence would repeat the code back at the reader.
    const reason = error.message === error.serviceCode ? undefined : error.message;
    return { kind: "refused", key: mapped.key, canRetry: mapped.canRetry, reason };
  }
  return { kind: "refused", key: "unknown", canRetry: true, reason: messageOf(error) };
}

function messageOf(error: unknown): string | undefined {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return typeof error === "string" && error.length > 0 ? error : undefined;
}
