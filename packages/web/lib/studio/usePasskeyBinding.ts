"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Hex } from "viem";
import { recallCredential, type RememberedKey } from "@/lib/passkey/browser";
import { reason } from "@/lib/chain/client";
import { getPasskey, type Passkey } from "@/lib/chain/registry";

/**
 * Where this wallet stands with its passkey, read from the registry rather than
 * from anything the browser remembers.
 *
 * "bound-elsewhere" is the interesting one: the chain holds a key this browser
 * cannot sign with, which is a creator on a second device rather than a
 * creator with a problem. It covers the browser that has never seen a key and
 * the browser whose remembered key was replaced by a later bind, because both
 * end the same way: unlock once here, or bind this device.
 */
export type BindingStatus = "reading" | "unbound" | "bound" | "bound-elsewhere" | "unreadable";

export interface Binding {
  status: BindingStatus;
  passkey: Passkey | null;
  credentialId: Uint8Array | undefined;
  error: string | null;
  refresh: () => void;
  /** Called after a recovery assertion proves this device holds the bound key. */
  remember: (key: RememberedKey) => void;
}

interface Answer {
  /** Which wallet and which read this answer belongs to, so a stale one is never shown. */
  wallet: Hex;
  tick: number;
  passkey: Passkey | null;
  /** Only ever a key this browser holds that matches the one on chain. */
  remembered: RememberedKey | undefined;
  error: string | null;
}

export function usePasskeyBinding(wallet: Hex | undefined): Binding {
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (wallet === undefined) {
      return;
    }

    let live = true;

    void (async () => {
      try {
        const passkey = await getPasskey(wallet);
        if (live) {
          // The recall drops a remembered key the chain no longer holds, so a
          // rotated passkey never leaves a stale credential behind to sign with.
          setAnswer({ wallet, tick, passkey, remembered: recallCredential(wallet, passkey), error: null });
        }
      } catch (thrown) {
        if (live) {
          setAnswer({ wallet, tick, passkey: null, remembered: undefined, error: reason(thrown) });
        }
      }
    })();

    return () => {
      live = false;
    };
  }, [wallet, tick]);

  const current = answer !== null && answer.wallet === wallet && answer.tick === tick ? answer : null;

  const refresh = useCallback(() => setTick((value) => value + 1), []);
  const remember = useCallback(
    (key: RememberedKey) =>
      setAnswer((previous) =>
        // An assertion that came back after the account changed says nothing
        // about the account on screen now.
        previous === null || previous.wallet !== wallet ? previous : { ...previous, remembered: key },
      ),
    [wallet],
  );

  return useMemo(
    () => ({
      status: bindingStatus(current),
      passkey: current?.passkey ?? null,
      credentialId: current?.remembered?.credentialId,
      error: current?.error ?? null,
      refresh,
      remember,
    }),
    [current, refresh, remember],
  );
}

export function bindingStatus(answer: { passkey: Passkey | null; remembered: RememberedKey | undefined; error: string | null } | null): BindingStatus {
  if (answer === null) {
    return "reading";
  }
  if (answer.error !== null) {
    return "unreadable";
  }
  if (answer.passkey === null) {
    return "unbound";
  }
  return answer.remembered === undefined ? "bound-elsewhere" : "bound";
}
