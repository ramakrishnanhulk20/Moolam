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

/** What one control of a platform is doing right now: its offer card, or its row in the settings. */
export type PlatformBusy = "mine" | "notMine" | "unmute" | "stop";

/** Where a press was made, and so where its waiting state and its failure are drawn. */
export type FailurePlace = "offer" | "setting";

/**
 * The key a press's waiting state and failure are held under. A platform can
 * have an offer card and a settings row at once, and both belong under the
 * control that was pressed, so the two never share a key.
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
  /** What each place is doing, by failureKey. */
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
  signedIn,
  account,
}: {
  getToken: () => Promise<string | null>;
  signIn: () => void;
  /** Privy's authenticated flag. */
  signedIn: boolean;
  /** Privy's user object, which Privy replaces when a sign-in completes. */
  account: unknown;
}): Claims {
  const [state, setState] = useState<ClaimsState>({ status: "reading", answer: null, refusal: null });
  const [busy, setBusy] = useState<Record<string, PlatformBusy>>({});
  const [failures, setFailures] = useState<Record<string, ClaimRefusal>>({});
  const [polls, setPolls] = useState(0);
  const live = useRef(true);
  // The list as last read, for a press that waited on another and must act on what is true now.
  const latest = useRef<ClaimsAnswer | null>(null);
  // The places with a press out, and each platform's queue, so one platform's presses run one after another.
  const pressed = useRef(new Set<string>());
  const lanes = useRef(new Map<string, Promise<void>>());
  // Set by a press on the sign-in step, spent by the one read made once Privy hands over a token.
  const [awaitingSignIn, setAwaitingSignIn] = useState(false);
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
    latest.current = outcome.value;
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

  /**
   * One press, with its waiting state and its failure line on the control that
   * was pressed and nowhere else.
   *
   * A platform's presses still run one after another. "These are mine" with
   * the tick writes a standing destination and "Stop" clears it; sent at once,
   * whichever the service took last would win, and a Stop could be undone by an
   * accept the person made before it. So a press on the other place of a busy
   * platform says "Saving your answer" where it was made, waits its turn, and
   * then acts on the list as read after the first one.
   */
  const run = useCallback(
    async (key: Hex, kind: PlatformBusy, act: (access: string, answer: ClaimsAnswer) => Promise<{ ok: true } | { ok: false; refusal: ClaimRefusal }>) => {
      const place = failureKey(placeOf(kind), key);
      if (latest.current === null || pressed.current.has(place)) return;
      pressed.current.add(place);
      setBusy((was) => ({ ...was, [place]: kind }));
      setFailures((was) => without(was, place));

      const lane = key.toLowerCase();
      const turn = (lanes.current.get(lane) ?? Promise.resolve()).then(async () => {
        const answer = latest.current;
        if (answer === null || !live.current) return;
        const access = await token.current().catch(() => null);
        const outcome = access === null ? ({ ok: false, refusal: SIGN_IN } as const) : await act(access, answer);
        if (!live.current) return;
        if (!outcome.ok) setFailures((was) => ({ ...was, [place]: outcome.refusal }));
        setPolls(0);
        await read();
      });
      const settled = turn.catch(() => undefined);
      lanes.current.set(lane, settled);
      try {
        await turn;
      } finally {
        pressed.current.delete(place);
        if (lanes.current.get(lane) === settled) lanes.current.delete(lane);
        if (live.current) setBusy((was) => without(was, place));
      }
    },
    [read],
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

  const login = useRef(signIn);
  useEffect(() => {
    login.current = signIn;
  }, [signIn]);

  const signInAgain = useCallback(() => {
    setAwaitingSignIn(true);
    login.current();
  }, []);

  /**
   * After a press on the sign-in step, the list reads itself once Privy has a
   * token again, and the sign-in lines go with that read. Looked for whenever
   * Privy's session changes; one press buys at most one read, so a service
   * that still refuses the token cannot set off a run of them.
   */
  useEffect(() => {
    if (!awaitingSignIn || !signedIn) return;
    let current = true;
    void token
      .current()
      .catch(() => null)
      .then(async (access) => {
        if (!current || access === null || !live.current) return;
        setAwaitingSignIn(false);
        if ((await read()) !== null && live.current) {
          setFailures((was) => Object.fromEntries(Object.entries(was).filter(([, refusal]) => refusal.key !== "signIn")));
        }
      });
    return () => {
      current = false;
    };
  }, [awaitingSignIn, signedIn, account, read]);

  return { ...state, busy, failures, watching, actions: { reload, mine, notMine, unmute, stop, signIn: signInAgain } };
}

function without<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}
