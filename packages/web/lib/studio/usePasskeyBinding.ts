"use client";

import { useCallback, useEffect, useState } from "react";
import type { Hex } from "viem";
import { recallCredential } from "@/lib/passkey/browser";
import { reason } from "@/lib/chain/client";
import { getPasskey, type Passkey } from "@/lib/chain/registry";

/**
 * Where this wallet stands with its passkey, read from the registry rather than
 * from anything the browser remembers.
 *
 * "bound-elsewhere" is the interesting one: the chain says a key is bound and
 * this browser has never seen it, which is a creator on a second device rather
 * than a creator with a problem.
 */
export type BindingStatus = "reading" | "unbound" | "bound" | "bound-elsewhere" | "unreadable";

export interface Binding {
  status: BindingStatus;
  passkey: Passkey | null;
  credentialId: Uint8Array | undefined;
  error: string | null;
  refresh: () => void;
  /** Called after a recovery assertion proves this device holds the bound key. */
  remember: (id: Uint8Array) => void;
}

interface Answer {
  /** Which wallet and which read this answer belongs to, so a stale one is never shown. */
  wallet: Hex;
  tick: number;
  passkey: Passkey | null;
  credentialId: Uint8Array | undefined;
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
          setAnswer({
            wallet,
            tick,
            passkey,
            credentialId: passkey === null ? undefined : recallCredential(wallet),
            error: null,
          });
        }
      } catch (thrown) {
        if (live) {
          setAnswer({ wallet, tick, passkey: null, credentialId: undefined, error: reason(thrown) });
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
    (id: Uint8Array) => setAnswer((previous) => (previous === null ? previous : { ...previous, credentialId: id })),
    [],
  );

  return {
    status: statusOf(current),
    passkey: current?.passkey ?? null,
    credentialId: current?.credentialId,
    error: current?.error ?? null,
    refresh,
    remember,
  };
}

function statusOf(answer: Answer | null): BindingStatus {
  if (answer === null) {
    return "reading";
  }
  if (answer.error !== null) {
    return "unreadable";
  }
  if (answer.passkey === null) {
    return "unbound";
  }
  return answer.credentialId === undefined ? "bound-elsewhere" : "bound";
}
