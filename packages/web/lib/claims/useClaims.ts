"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Hex } from "viem";
import type { ConsentDraft } from "@/lib/consent/call";
import { sayMine, sayNotMine } from "./answer";
import { readClaims, stopStanding, unmutePlatform, type ClaimsAnswer } from "./client";
import { termsFromDraft } from "./offers";
import type { ClaimRefusal } from "./refusal";

/** How often the list is read again while a platform is handing pictures over. */
export const HANDOVER_POLL_MS = 15_000;

/**
 * The most reads in one wait. Every read spends from the person's own daily
 * allowance at the service, so a platform that never delivers costs twenty, and
 * then the page offers a button rather than reading on.
 */
export const HANDOVER_POLLS = 20;

/** What one platform's card is doing right now. */
export type PlatformBusy = "mine" | "notMine" | "unmute" | "stop";

/** Where a failure is drawn: under the platform's offer card, or under its row in the settings. */
export type FailurePlace = "offer" | "setting";

/**
 * The key a failure is held under. A platform can have an offer card and a
 * settings row at once, and a refusal belongs under the control that was
 * pressed, so the two never share a key.
 */
export function failureKey(place: FailurePlace, platformKeyHash: string): string {
  return `${place}:${platformKeyHash.toLowerCase()}`;
}

function placeOf(kind: PlatformBusy): FailurePlace {
  return kind === "mine" || kind === "notMine" ? "offer" : "setting";
}

export interface ClaimsState {
  status: "reading" | "ready" | "failed";
  answer: ClaimsAnswer | null;
  /** Why the list could not be read, when it could not. Kept through the next read so the line does not blink out under the press. */
  refusal: ClaimRefusal | null;
}

export interface Claims extends ClaimsState {
  busy: Readonly<Record<string, PlatformBusy>>;
  /** The last refusal for one platform's card or settings row, by failureKey. */
  failures: Readonly<Record<string, ClaimRefusal>>;
  /** True while the page is reading the list again for a handover. */
  watching: boolean;
  actions: {
    reload: () => void;
    mine: (platformKeyHash: Hex, draft: ConsentDraft, sendFuture: boolean) => Promise<void>;
    notMine: (platformKeyHash: Hex) => Promise<void>;
    unmute: (platformKeyHash: Hex) => Promise<void>;
    stop: (platformKeyHash: Hex) => Promise<void>;
    signIn: () => void;
  };
}

const SIGN_IN: ClaimRefusal = { key: "signIn", next: "signIn" };

/**
 * The claims list for the signed-in person, and their answers to it.
 *
 * The token is asked of Privy for every call and handed to the client, which
 * puts it in the Authorization header and nowhere else. After any answer the
 * list is read again, because the service's state is the truth and the page's
 * guess at it is not.
 */
export function useClaims({
  getToken,
  signIn,
}: {
  getToken: () => Promise<string | null>;
  signIn: () => void;
}): Claims {
  const [state, setState] = useState<ClaimsState>({ status: "reading", answer: null, refusal: null });
  const [busy, setBusy] = useState<Record<string, PlatformBusy>>({});
  const [failures, setFailures] = useState<Record<string, ClaimRefusal>>({});
  const [polls, setPolls] = useState(0);
  const live = useRef(true);
  // Privy hands back a new getAccessToken on some renders; reads keep the latest.
  const token = useRef(getToken);
  useEffect(() => {
    token.current = getToken;
  }, [getToken]);

  const read = useCallback(async (): Promise<ClaimsAnswer | null> => {
    // A read after a failed one says so, so its button can rest until the answer is in.
    if (live.current) setState((was) => (was.status === "failed" ? { ...was, status: "reading" } : was));
    const access = await token.current().catch(() => null);
    if (access === null) {
      if (live.current) setState((was) => ({ ...was, status: "failed", refusal: SIGN_IN }));
      return null;
    }
    const outcome = await readClaims(access);
    if (!live.current) return null;
    if (!outcome.ok) {
      setState((was) => ({ ...was, status: was.answer === null ? "failed" : "ready", refusal: outcome.refusal }));
      return null;
    }
    setState({ status: "ready", answer: outcome.value, refusal: null });
    return outcome.value;
  }, []);

  useEffect(() => {
    live.current = true;
    void read();
    return () => {
      live.current = false;
    };
  }, [read]);

  const handingOver = state.answer?.waiting.some((entry) => entry.state === "accepted") === true;
  const watching = handingOver && polls < HANDOVER_POLLS;

  useEffect(() => {
    if (!watching) return;
    const timer = window.setTimeout(() => {
      setPolls((was) => was + 1);
      void read();
    }, HANDOVER_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [watching, polls, read]);

  /** One platform's action, with its card locked while it runs and its own failure line after. */
  const run = useCallback(
    async (key: Hex, kind: PlatformBusy, act: (access: string, answer: ClaimsAnswer) => Promise<{ ok: true } | { ok: false; refusal: ClaimRefusal }>) => {
      const answer = state.answer;
      if (answer === null || busy[key] !== undefined) return;
      const place = failureKey(placeOf(kind), key);
      setBusy((was) => ({ ...was, [key]: kind }));
      setFailures((was) => without(was, place));
      const access = await token.current().catch(() => null);
      const outcome = access === null ? ({ ok: false, refusal: SIGN_IN } as const) : await act(access, answer);
      if (!live.current) return;
      if (!outcome.ok) setFailures((was) => ({ ...was, [place]: outcome.refusal }));
      setPolls(0);
      await read();
      if (live.current) setBusy((was) => without(was, key));
    },
    [busy, read, state.answer],
  );

  const mine = useCallback(
    async (key: Hex, draft: ConsentDraft, sendFuture: boolean) =>
      await run(key, "mine", async (access, answer) => await sayMine(answer, key, { terms: termsFromDraft(draft), sendFuture }, access)),
    [run],
  );
  const notMine = useCallback(
    async (key: Hex) => await run(key, "notMine", async (access, answer) => await sayNotMine(answer, key, access)),
    [run],
  );
  const unmute = useCallback(
    async (key: Hex) => await run(key, "unmute", async (access) => await unmutePlatform(key, access)),
    [run],
  );
  const stop = useCallback(async (key: Hex) => await run(key, "stop", async (access) => await stopStanding(key, access)), [run]);

  const reload = useCallback(() => {
    setPolls(0);
    void read();
  }, [read]);

  return { ...state, busy, failures, watching, actions: { reload, mine, notMine, unmute, stop, signIn } };
}

function without<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}
