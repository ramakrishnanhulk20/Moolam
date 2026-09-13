import type { Hex } from "viem";
import { CHAIN_ID, addresses } from "@/lib/chain/client";
import { decodeRegistryError, flagCalldata } from "@/lib/chain/calldata";
import { ConfirmTimeout } from "@/lib/studio/confirm";
import { checkReason, evidenceUri, type ReasonProblem } from "./evidence";

/** The two honest steps between pressing the button and a dispute on the record. */
export type FlagStep = "account" | "send";
export type StepState = "waiting" | "running" | "done" | "failed";

export const FLAG_STEPS: readonly FlagStep[] = ["account", "send"];

/** One failure, in the words the panel prints and the one thing worth doing about it. */
export interface FlagFailure {
  /** A string under "passport.dispute.failure". */
  key: string;
  /** The chain's or the wallet's own words, printed under the sentence. */
  reason?: string;
  /** The single button offered under the message. */
  next?: "again" | "recheck" | "signIn";
  /** How much more MON the account needs, in wei, for the message that names it. */
  shortfall?: bigint;
}

export interface FlagState {
  /** The panel is a link until somebody opens it. */
  open: boolean;
  reason: string;
  steps: Record<FlagStep, StepState>;
  hash?: Hex;
  block: bigint | null;
  /** True while the send is out and Monad is being watched for the dispute. */
  confirming: boolean;
  failure: FlagFailure | null;
}

export type FlagAction =
  | { type: "open" }
  | { type: "close" }
  | { type: "reason"; reason: string }
  | { type: "start" }
  | { type: "sent"; hash?: Hex }
  | { type: "recorded"; block: bigint | null }
  | { type: "failed"; failure: FlagFailure; stage: FlagStep }
  | { type: "reset" };

export const initialFlagState: FlagState = {
  open: false,
  reason: "",
  steps: { account: "waiting", send: "waiting" },
  block: null,
  confirming: false,
  failure: null,
};

export function flagReducer(state: FlagState, action: FlagAction): FlagState {
  switch (action.type) {
    case "open":
      return { ...state, open: true };
    case "close":
      return { ...state, open: false };
    case "reason":
      return { ...state, reason: action.reason, failure: null };
    case "start":
      return { ...state, failure: null, confirming: false, steps: { account: "running", send: "waiting" } };
    case "sent":
      return { ...state, hash: action.hash, confirming: true, steps: { account: "done", send: "running" } };
    case "recorded":
      return { ...state, block: action.block, confirming: false, steps: { account: "done", send: "done" } };
    case "failed":
      return {
        ...state,
        confirming: false,
        failure: action.failure,
        steps:
          action.stage === "send"
            ? { account: "done", send: "failed" }
            : { account: "failed", send: "waiting" },
      };
    case "reset":
      return { ...initialFlagState, open: true, reason: state.reason };
  }
}

export function isFlagBusy(state: FlagState): boolean {
  return state.steps.account === "running" || state.steps.send === "running";
}

export function isFlagDone(state: FlagState): boolean {
  return state.steps.send === "done";
}

/** What the account holds against what the bond costs. */
export interface BondCheck {
  enough: boolean;
  /** How much more MON is needed, in wei. Zero when there is enough. */
  shortfall: bigint;
}

/**
 * Whether this account can post the bond, and by how much it falls short.
 *
 * Privy pays the network fee, so the whole bond is what the balance has to
 * cover and nothing is held back for gas. Null until both numbers are read:
 * a panel that guessed either would either promise a send that reverts or
 * refuse one that would have worked.
 */
export function bondCheck(balance: bigint | null, bond: bigint | null): BondCheck | null {
  if (balance === null || bond === null) {
    return null;
  }
  return balance >= bond ? { enough: true, shortfall: 0n } : { enough: false, shortfall: bond - balance };
}

/** What the wallet is asked to send: the registry, the call, and the bond riding on it. */
export interface FlagRequest {
  to: Hex;
  data: Hex;
  value: bigint;
  chainId: number;
}

/**
 * One flag, ready for the wallet.
 *
 * The bond is the value on the transaction, taken from the challenger's own
 * account. The registry checks it against the policy to the wei, so the number
 * here is the one that was read from the policy and never a copy kept in the app.
 */
export function flagRequest({
  passportId,
  reason,
  bond,
}: {
  passportId: Hex;
  reason: string;
  bond: bigint;
}): FlagRequest {
  return {
    to: addresses.registry,
    data: flagCalldata(passportId, evidenceUri(reason)),
    value: bond,
    chainId: CHAIN_ID,
  };
}

/** Which sentence each revert the registry can throw at a flag gets. */
const REVERT_KEYS: Record<string, { key: string; next?: FlagFailure["next"] }> = {
  InvalidBond: { key: "badBond", next: "again" },
  DisputeAlreadyOpen: { key: "alreadyOpen" },
  PassportAlreadyDisputed: { key: "alreadyDisputed" },
  PassportNotFound: { key: "notFound" },
  EnforcedPause: { key: "paused" },
  NotResolver: { key: "notResolver" },
  NoOpenDispute: { key: "noOpenDispute" },
  NothingToWithdraw: { key: "nothingOwed" },
};

/** The problem with the typed reason, as a failure the panel can print. */
export function reasonFailure(reason: string): FlagFailure | null {
  const problem: ReasonProblem | null = checkReason(reason);
  return problem === null ? null : { key: problem };
}

/** Whether the person closed the wallet window themselves, which is not a failure to apologise for. */
function wasDeclined(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 4001) {
    return true;
  }
  return /user (rejected|denied|declined)|rejected the request|cancell?ed|closed/i.test(messageOf(error));
}

/**
 * One failure from a flag, a resolve or a withdraw, turned into the line the
 * screen prints.
 *
 * A revert is named first, because the registry's own error is the most useful
 * thing anyone can be told. A wait that ran out is never a failed send: the
 * transaction may still land, so that path offers a second look and never a
 * second send.
 */
export function describeFlagFailure(error: unknown): FlagFailure {
  if (error instanceof ConfirmTimeout) {
    return { key: "confirmPending", next: "recheck" };
  }
  if (wasDeclined(error)) {
    return { key: "declined", next: "again" };
  }

  const revert = decodeRegistryError(error);
  if (revert !== undefined && REVERT_KEYS[revert] !== undefined) {
    return { ...REVERT_KEYS[revert], reason: revert };
  }

  const text = messageOf(error);
  if (/insufficient funds|exceeds the balance|not enough/i.test(text)) {
    return { key: "notEnough", reason: text };
  }
  return { key: "unknown", reason: text, next: "again" };
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
