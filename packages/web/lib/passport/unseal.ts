"use client";

import { usePrivy, useWallets } from "@privy-io/react-auth";
import { useCallback, useMemo, useReducer, useState } from "react";
import type { Hex } from "viem";
import { sha256Of } from "@/lib/sealed/handback";
import { checkImage, type RefusalCode } from "@/lib/upload/checkImage";
import { VerifierError, unseal, type QuotaState, type UnsealResponse } from "@/lib/verifier/client";
import { ownsPassport } from "./owner";

/**
 * The holder's side of a sealed passport: publish the picture it committed to.
 *
 * Two things happen here that happen nowhere else in the app. The file is
 * hashed on the device and held against the passport id before a byte is
 * uploaded, so a wrong file never leaves the machine and never spends the
 * holder's allowance. And the one call that follows cannot be undone: when it
 * answers, the picture is on IPFS for good. Everything below is written around
 * those two facts.
 */

/** One failure, in the words the panel prints and the one thing worth doing about it. */
export interface UnsealFailure {
  /** A string under "passport.unseal.failure". */
  key: string;
  /** The service's or the browser's own words, printed under the sentence. */
  reason?: string;
  /** The single button offered under the message. */
  next?: "again" | "chooseAgain" | "signIn" | "later" | "showPicture";
}

/** The file this browser has chosen and proved, with what the panel prints about it. */
export interface KeptFile {
  file: File;
  name: string;
  size: number;
}

export interface UnsealState {
  /** The chosen file, kept only once its hash matched the passport id. */
  kept: KeptFile | null;
  /** True while the browser reads and hashes the chosen file. */
  checking: boolean;
  /** True while the request is out and the service is pinning. */
  sending: boolean;
  /** The four addresses the picture now lives at. */
  result: UnsealResponse | null;
  /** What this account has spent on edits and unseals today, kept across a refusal. */
  quota: QuotaState | null;
  failure: UnsealFailure | null;
}

export type UnsealAction =
  | { type: "checking" }
  | { type: "kept"; kept: KeptFile }
  | { type: "sending" }
  | { type: "published"; result: UnsealResponse }
  | { type: "failed"; failure: UnsealFailure; quota?: QuotaState }
  | { type: "reset" };

export const initialUnsealState: UnsealState = {
  kept: null,
  checking: false,
  sending: false,
  result: null,
  quota: null,
  failure: null,
};

export function unsealReducer(state: UnsealState, action: UnsealAction): UnsealState {
  switch (action.type) {
    case "checking":
      // The old file goes at the moment a new one is chosen. A panel that kept
      // the last proved file under a new name would publish the wrong bytes.
      return { ...state, kept: null, checking: true, failure: null };
    case "kept":
      return { ...state, kept: action.kept, checking: false, failure: null };
    case "sending":
      return { ...state, sending: true, failure: null };
    case "published":
      return { ...state, sending: false, result: action.result, quota: action.result.quota ?? state.quota, failure: null };
    case "failed":
      return { ...state, checking: false, sending: false, failure: action.failure, quota: action.quota ?? state.quota };
    case "reset":
      return { ...initialUnsealState, quota: state.quota };
  }
}

export function isUnsealBusy(state: UnsealState): boolean {
  return state.checking || state.sending;
}

export function isUnsealDone(state: UnsealState): boolean {
  return state.result !== null;
}

/** Which line under "passport.unseal.failure" a file the browser refuses gets. */
const UPLOAD_KEYS: Record<RefusalCode, string> = {
  "too-large": "tooLarge",
  "not-an-image": "notAnImage",
  empty: "empty",
};

/**
 * Invariant 6 of the sealed threat model, run on the device: the file about to
 * be published is the very file the passport commits to.
 *
 * The service checks the same thing against the chain and its answer is still
 * the one that counts. Running it here first means the common mistake, a
 * creator reaching for their own copy of the picture rather than the signed
 * file this service handed back, is caught before a 20 MB upload, before the
 * allowance is touched, and without those bytes leaving the machine at all.
 */
export async function checkKeptFile(file: File, passportId: Hex): Promise<{ ok: true; kept: KeptFile } | { ok: false; failure: UnsealFailure }> {
  const refusal = checkImage(file);
  if (refusal !== null) {
    return { ok: false, failure: { key: UPLOAD_KEYS[refusal.code], reason: refusal.reason, next: "chooseAgain" } };
  }

  let sha256: string;
  try {
    sha256 = await sha256Of(new Uint8Array(await file.arrayBuffer()));
  } catch (error) {
    return { ok: false, failure: { key: "unreadable", reason: messageOf(error), next: "chooseAgain" } };
  }

  if (sha256.toLowerCase() !== passportId.toLowerCase()) {
    return { ok: false, failure: { key: "notTheFile", next: "chooseAgain" } };
  }

  return { ok: true, kept: { file, name: file.name, size: file.size } };
}

/**
 * Which sentence each answer from the service gets, read off its own word in
 * the body rather than off the status, because /unseal answers one status with
 * several different words.
 *
 * Three of these are not failures in the ordinary sense. `not-sealed` and
 * `already-unsealed` both mean the picture is public already, so the way out is
 * to look at the page rather than to try again. `record-pin-failed` is the one
 * half-done state the route can end in: the picture is out there and the record
 * that points at it is not, and the holder has to be told that in those words,
 * not left with a bare failure while their picture is public.
 */
const SERVICE_KEYS: Record<string, { key: string; next?: UnsealFailure["next"] }> = {
  "hash-mismatch": { key: "notTheFile", next: "chooseAgain" },
  "fingerprint-mismatch": { key: "fingerprintMismatch", next: "chooseAgain" },
  "not-holder": { key: "notHolder" },
  "no-passport": { key: "noPassport" },
  "not-sealed": { key: "notSealed", next: "showPicture" },
  "already-unsealed": { key: "alreadyUnsealed", next: "showPicture" },
  "thumbnail-too-large": { key: "thumbnailTooLarge" },
  quota: { key: "quota" },
  "global-limit": { key: "todayFull", next: "later" },
  "pin-failed": { key: "pinFailed", next: "again" },
  "record-pin-failed": { key: "recordPinFailed", next: "again" },
  "chain-unavailable": { key: "dependencyDown", next: "later" },
  "metadata-unavailable": { key: "dependencyDown", next: "later" },
  "privy-unavailable": { key: "dependencyDown", next: "later" },
  // The lookup only answers this on a GET, so it reaches this table through a
  // service that ever names it here. Named all the same: a documented code is
  // worth its own sentence rather than "a shape this app does not know".
  "lookup-unavailable": { key: "lookupUnavailable", next: "again" },
  busy: { key: "busy", next: "again" },
  unauthorized: { key: "signedOut", next: "signIn" },
  "not-an-image": { key: "notAnImage", next: "chooseAgain" },
  "too-large": { key: "tooLarge", next: "chooseAgain" },
  "rate-limited": { key: "rateLimited", next: "later" },
  "bad-request": { key: "badRequest", next: "chooseAgain" },
  offline: { key: "offline", next: "again" },
  "bad-response": { key: "badResponse", next: "again" },
};

/** One failure from the publish request, turned into the line the panel prints. */
export function describeUnsealFailure(error: unknown): UnsealFailure {
  if (error instanceof VerifierError) {
    const mapped = SERVICE_KEYS[error.serviceCode ?? ""] ?? SERVICE_KEYS[error.code] ?? { key: "badResponse", next: "again" as const };
    // Several refusals are named in the body and nothing else, so printing the
    // service's word under the sentence would repeat the code back at the reader.
    return error.message === error.serviceCode ? mapped : { ...mapped, reason: error.message };
  }
  return { key: "unknown", reason: messageOf(error), next: "again" };
}

/** Everything the publish panel needs, and nothing the rest of the page reads. */
export interface PassportUnseal {
  /** Privy has answered about this session. Until then the panel draws nothing. */
  ready: boolean;
  /** The signed in account holds this passport. Everyone else is shown nothing at all. */
  isHolder: boolean;
  state: UnsealState;
  actions: {
    choose: (file: File) => Promise<void>;
    publish: () => Promise<void>;
    signIn: () => void;
    reset: () => void;
  };
}

/**
 * The holder's publish, from the chosen file to the picture on IPFS.
 *
 * Nothing is signed and no transaction is sent: the registry wrote this
 * passport's metadata address once and has no setter for it, so opening a
 * sealed passport is four pins and a small record beside them, and the chain is
 * not touched at all.
 */
export function useUnsealPassport({
  passportId,
  owner,
  onPublished,
}: {
  passportId: Hex;
  owner: Hex | null;
  /** Called once the picture is public, so the page can read itself again. */
  onPublished?: () => void;
}): PassportUnseal {
  const { ready, authenticated, login, getAccessToken } = usePrivy();
  const { wallets } = useWallets();
  const [state, dispatch] = useReducer(unsealReducer, initialUnsealState);
  // Kept out of the reducer on purpose: two presses of Publish must never send
  // two uploads, and a flag read straight after a dispatch is a stale flag.
  const [sending, setSending] = useState(false);

  const wallet = useMemo(
    () => wallets.find((entry) => entry.walletClientType === "privy")?.address,
    [wallets],
  );

  const choose = useCallback(
    async (file: File) => {
      dispatch({ type: "checking" });
      const checked = await checkKeptFile(file, passportId);
      if (checked.ok) {
        dispatch({ type: "kept", kept: checked.kept });
      } else {
        dispatch({ type: "failed", failure: checked.failure });
      }
    },
    [passportId],
  );

  const publish = useCallback(async () => {
    if (state.kept === null) {
      dispatch({ type: "failed", failure: { key: "fileMissing", next: "chooseAgain" } });
      return;
    }
    if (sending || state.result !== null) {
      return;
    }

    setSending(true);
    dispatch({ type: "sending" });
    try {
      const token = await getAccessToken();
      if (token === null) {
        throw new Error("this session has no access token, so the verify service cannot be called");
      }
      const result = await unseal({ file: state.kept.file, passportId, accessToken: token });
      dispatch({ type: "published", result });
      onPublished?.();
    } catch (error) {
      dispatch({
        type: "failed",
        failure: describeUnsealFailure(error),
        quota: error instanceof VerifierError ? error.quota : undefined,
      });
    } finally {
      setSending(false);
    }
  }, [getAccessToken, onPublished, passportId, sending, state.kept, state.result]);

  return {
    ready,
    isHolder: authenticated && ownsPassport(owner, wallet),
    state,
    actions: { choose, publish, signIn: login, reset: () => dispatch({ type: "reset" }) },
  };
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : String(error);
}
