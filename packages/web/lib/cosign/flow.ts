import type { Hex } from "viem";
import type { ConsentDraft } from "@/lib/consent/call";
import type { ConsentFailure } from "@/lib/consent/failure";
import type { BindingStatus } from "@/lib/studio/usePasskeyBinding";
import type { Failure } from "@/lib/studio/problems";
import type { CosignRecord, Named, RecordOutcome } from "./record";

/**
 * Every state the co-sign page can be in, in the order a person meets them,
 * as the lab drew them. "passkeyElsewhere" is P11's case: the wallet already
 * has a passkey and this device cannot use it, so the page asks rather than
 * rebinding on its own.
 */
export const COSIGN_STATES = [
  "signIn",
  "makePasskey",
  "passkeyElsewhere",
  "wrongWallet",
  "waitingAgent",
  "ready",
  "signing",
  "registered",
  "expired",
  "failed",
] as const;

export type CosignState = (typeof COSIGN_STATES)[number];

/** The ten, plus the two moments with nothing to draw yet: reading, and a link that leads nowhere. */
export type CosignView = CosignState | "loading" | "notFound";

/** Why a failed page failed. Each one is its own sentence, because each one leaves the person somewhere else. */
export type FailReason = "mismatch" | "taken" | "refused" | "unavailable" | "unconfirmed";

/** Where the P1 check has got to: the picture, the metadata and the digest held against the record and the registry. */
export type Gate =
  | { at: "idle" }
  | { at: "checking" }
  | { at: "passed"; digest: Hex }
  | { at: "failed"; what: "record" | "registry" | "picture" | "metadata"; local?: Hex; other?: Hex };

/** What the page may draw once the pinned files have been checked against what the passport commits to. */
export interface Drawn {
  /** A blob: address of the very bytes whose sha256 is the passport id. */
  picture: string;
  title: string | null;
  /** The AI-use terms the metadata document carries, or null when it states none. */
  terms: ConsentDraft | null;
}

/**
 * The register send, from the passkey prompt to a receipt. "unconfirmed" is
 * not a failure: the wallet took the transaction and no receipt has shown it
 * yet, so nothing may be sent again from here.
 */
export type Send =
  | { at: "idle"; failure: Failure | null }
  | { at: "signing" }
  | { at: "sending" }
  | { at: "confirming" }
  | { at: "unconfirmed"; failure: Failure | null }
  | { at: "registered"; passportId: Hex; txHash: Hex };

/** Binding this device's passkey, which happens only on a press (P11). */
export type Bind =
  | { at: "idle"; failure: Failure | null }
  | { at: "creating" }
  | { at: "waiting" }
  | { at: "sending" }
  | { at: "recovering" };

/**
 * The second transaction: the record's terms, written to the consent register
 * once the passport is on chain. On a page opened again after the passport
 * landed, the register is read first: terms already there are named with their
 * writer and left alone ("stated"); none there, and the file carries some, the
 * page offers to write them on a press ("offered").
 */
export type Terms =
  | { at: "none" }
  | { at: "waiting" }
  | { at: "offered" }
  | { at: "stated"; writer: Hex }
  | { at: "sending" }
  | { at: "written"; txHash: Hex }
  | { at: "failed"; failure: ConsentFailure };

export interface CosignModel {
  view: CosignView;
  handle: "unread" | "bad" | "ok";
  auth: "unknown" | "out" | "in";
  open: "idle" | "opening" | "answered";
  refusal: Exclude<RecordOutcome["kind"], "record" | "signIn"> | null;
  named: Named | null;
  record: CosignRecord | null;
  /** True once chain time has passed the record's deadline (P12). */
  expired: boolean;
  binding: BindingStatus;
  gate: Gate;
  drawn: Drawn | null;
  /** Someone else's passport already holds these bytes (P6). */
  taken: { holder: Hex | null } | null;
  send: Send;
  bind: Bind;
  terms: Terms;
}

export type CosignAction =
  | { type: "handle"; valid: boolean }
  | { type: "auth"; signedIn: boolean }
  | { type: "opening" }
  | { type: "answer"; outcome: RecordOutcome }
  | { type: "binding"; status: BindingStatus }
  | { type: "expired" }
  | { type: "gate"; gate: Gate }
  | { type: "drawn"; drawn: Drawn }
  | { type: "taken"; holder: Hex | null }
  | { type: "send"; send: Send }
  | { type: "bind"; bind: Bind }
  | { type: "terms"; terms: Terms }
  /** Ask the service again after it did not answer. Only reads run again; nothing signed is sent twice. */
  | { type: "retry" }
  /** Another account signed in on this tab: nothing of the last one's record is theirs. */
  | { type: "account" };

const IDLE_SEND: Send = { at: "idle", failure: null };
const IDLE_BIND: Bind = { at: "idle", failure: null };

const FRESH: Omit<CosignModel, "view"> = {
  handle: "unread",
  auth: "unknown",
  open: "idle",
  refusal: null,
  named: null,
  record: null,
  expired: false,
  binding: "reading",
  gate: { at: "idle" },
  drawn: null,
  taken: null,
  send: IDLE_SEND,
  bind: IDLE_BIND,
  terms: { at: "none" },
};

export const initialCosign: CosignModel = { ...FRESH, view: "loading" };

/**
 * The one reducer the co-sign page runs on. Actions record facts; the state a
 * person sees is worked out from all of them together by viewOf, so no two
 * buttons can disagree about where the page is.
 */
export function cosignReducer(model: CosignModel, action: CosignAction): CosignModel {
  return settle(apply(model, action));
}

function apply(model: CosignModel, action: CosignAction): CosignModel {
  switch (action.type) {
    case "handle":
      return { ...model, handle: action.valid ? "ok" : "bad" };
    case "auth":
      if (action.signedIn) {
        return { ...model, auth: "in" };
      }
      // Signed out, the record is no longer this tab's to show.
      return { ...FRESH, view: model.view, handle: model.handle, auth: "out" };
    case "opening":
      return { ...model, open: "opening" };
    case "answer":
      return answered(model, action.outcome);
    case "binding":
      return { ...model, binding: action.status };
    case "expired":
      return { ...model, expired: true };
    case "gate":
      return { ...model, gate: action.gate };
    case "drawn":
      return { ...model, drawn: action.drawn };
    case "taken":
      return { ...model, taken: { holder: action.holder } };
    case "send":
      return { ...model, send: action.send };
    case "bind":
      return { ...model, bind: action.bind };
    case "terms":
      return { ...model, terms: action.terms };
    case "retry":
      return { ...model, open: "idle", refusal: null, gate: { at: "idle" }, taken: null };
    case "account":
      return { ...FRESH, view: model.view, handle: model.handle, auth: model.auth };
  }
}

function answered(model: CosignModel, outcome: RecordOutcome): CosignModel {
  if (outcome.kind === "signIn") {
    return { ...FRESH, view: model.view, handle: model.handle, auth: "out" };
  }
  if (outcome.kind !== "record") {
    const named = "named" in outcome ? outcome.named : null;
    return { ...model, open: "answered", refusal: outcome.kind, named: named ?? model.named };
  }
  const record = outcome.record;
  // A status answer names no digest to the person, so the one the record route
  // gave is kept; every other field is the service's latest word.
  const digest = record.digest ?? model.record?.digest;
  const agentSignature = record.agentSignature ?? model.record?.agentSignature;
  return {
    ...model,
    open: "answered",
    refusal: null,
    named: { agentId: record.agentId, platform: record.platform, exactHash: record.exactHash },
    record: { ...record, digest, agentSignature },
  };
}

function settle(model: CosignModel): CosignModel {
  const view = viewOf(model);
  return view === model.view ? model : { ...model, view };
}

/**
 * Where the page is, from everything it knows. The order is the order of
 * precedence: a landed passport outranks a clock that ran out a second later,
 * and a send in flight outranks everything but the landing, because the
 * transaction may still arrive.
 */
export function viewOf(model: CosignModel): CosignView {
  if (model.handle === "bad") return "notFound";
  if (model.handle === "unread" || model.auth === "unknown") return "loading";
  if (model.auth === "out") return "signIn";
  if (model.send.at === "registered") return "registered";
  if (model.open !== "answered") return "loading";

  switch (model.refusal) {
    case "notFound":
      return "notFound";
    case "wrongWallet":
      return "wrongWallet";
    case "expired":
      return "expired";
    case "refused":
    case "unavailable":
      return "failed";
    case null:
      break;
  }

  const record = model.record;
  if (record === null) return "loading";
  if (model.send.at === "signing" || model.send.at === "sending" || model.send.at === "confirming") return "signing";
  if (model.send.at === "unconfirmed") return "failed";
  if (model.taken !== null || record.state === "failed") return "failed";
  if (record.state === "expired" || model.expired) return "expired";
  if (record.state === "registered") return "loading";
  if (model.gate.at === "failed") return "failed";
  if (model.binding === "unreadable") return "failed";
  if (model.binding === "unbound") return "makePasskey";
  if (model.binding === "bound-elsewhere") return "passkeyElsewhere";
  if (record.state === "awaiting-creator" || record.state === "creator-set") return "waitingAgent";
  return "ready";
}

/** Which sentence a failed page says. Null for any other state. */
export function failReason(model: CosignModel): FailReason | null {
  if (model.view !== "failed") return null;
  if (model.refusal === "refused") return "refused";
  if (model.refusal === "unavailable" || model.binding === "unreadable") return "unavailable";
  if (model.send.at === "unconfirmed") return "unconfirmed";
  if (model.taken !== null || model.record?.state === "failed") return "taken";
  return "mismatch";
}

/**
 * Whether the passkey button may be pressed: the page is ready, all three
 * digests agreed and the picture's bytes hashed to the passport id (P1), this
 * device holds the bound key, the chain's clock has not passed the deadline
 * (P12), and nothing is out already.
 */
export function canSign(model: CosignModel): boolean {
  return (
    model.view === "ready" &&
    model.gate.at === "passed" &&
    model.binding === "bound" &&
    !model.expired &&
    model.taken === null &&
    model.send.at === "idle" &&
    model.record?.agentSignature !== undefined
  );
}

/** True while a bind or a recovery is running, so neither can be started twice. */
export function bindBusy(model: CosignModel): boolean {
  return model.bind.at !== "idle";
}

/**
 * The work the page starts on its own, from what it knows. Binding a passkey
 * is never among them: it is a transaction and it replaces a key, so it runs
 * only from a press (P11).
 */
export interface Automatic {
  /** Open the record with the person's token: the first open writes them in as its creator (P2). */
  open: boolean;
  /** Ask the status route again while the agent has still to sign, until the deadline. */
  poll: boolean;
  /** Run the P1 and P6 checks on a signed, pinned record. */
  gate: boolean;
  /** Read the chain's clock against the deadline (P12). */
  clock: boolean;
  /** Find the receipt behind a passport the status route says is registered (P13). */
  landed: boolean;
  /** Write the record's terms once the passport's receipt is in (P9). */
  terms: boolean;
}

export function automatic(model: CosignModel): Automatic {
  const record = model.record;
  const live = model.auth === "in" && model.handle === "ok" && model.refusal === null;
  const waiting = record !== null && (record.state === "awaiting-creator" || record.state === "creator-set");
  const idle = model.send.at === "idle";
  return {
    open: model.auth === "in" && model.handle === "ok" && model.open === "idle",
    poll: live && waiting && !model.expired,
    gate: live && record?.state === "signed" && model.gate.at === "idle" && model.taken === null && !model.expired,
    clock:
      live &&
      record !== null &&
      record.passport.deadline !== undefined &&
      !model.expired &&
      (record.state === "creator-set" || record.state === "signed") &&
      (idle || model.send.at === "signing"),
    landed: live && record?.state === "registered" && idle,
    terms: model.send.at === "registered" && model.terms.at === "waiting",
  };
}

/** What a press on one of a state's two buttons asks for. The page maps each to one handler. */
export type Press =
  | "signIn"
  | "bind"
  | "recover"
  | "signOut"
  | "sign"
  | "retry"
  | "recheck"
  | "writeTerms"
  | "unsponsored"
  | "openPassport";

/** The press behind each state's buttons, or null where the state offers none. */
export function pressFor(model: CosignModel, which: "primary" | "secondary"): Press | null {
  switch (model.view) {
    case "signIn":
      return which === "primary" ? "signIn" : null;
    case "makePasskey":
      return which === "primary" ? "bind" : null;
    case "passkeyElsewhere":
      // Replacing the bound key is its own press, never a side effect of the first (P11).
      return which === "primary" ? "recover" : "bind";
    case "wrongWallet":
      return which === "secondary" ? "signOut" : null;
    case "ready":
      return which === "primary" ? "sign" : null;
    case "registered":
      if (which === "primary") return "openPassport";
      return model.terms.at === "failed" || model.terms.at === "offered" ? "writeTerms" : null;
    case "failed": {
      if (which !== "primary") return null;
      const reason = failReason(model);
      if (reason === "unconfirmed") return "recheck";
      if (reason === "unavailable") return "retry";
      return null;
    }
    default:
      return null;
  }
}
