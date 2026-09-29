"use client";

import { usePrivy } from "@privy-io/react-auth";
import { useEffect, useRef } from "react";
import { PrivyProvider } from "@/components/providers/PrivyProvider";
import { RETURNING_KEY } from "@/components/providers/WalletProvider";

/**
 * Under the page's own wallet: says whether the reader is signed in, and opens
 * sign-in each time the hint's button is pressed. Null until Privy has looked
 * for a session, because "not yet" is not "signed out".
 */
export function SignedOutCheck({ onAnswer, asks }: { onAnswer: (signedIn: boolean | null) => void; asks: number }) {
  const { ready, authenticated, login } = usePrivy();

  useEffect(() => {
    onAnswer(ready ? authenticated : null);
  }, [ready, authenticated, onAnswer]);

  const answered = useRef(0);
  useEffect(() => {
    if (asks > answered.current && ready) {
      answered.current = asks;
      login();
    }
  }, [asks, ready, login]);

  return null;
}

/**
 * On a device that never signed in, the page has no wallet mounted, so the hint
 * brings its own for the length of one sign-in.
 */
export function SignInHere({ asks }: { asks: number }) {
  return (
    <PrivyProvider>
      <SignInOnce asks={asks} />
    </PrivyProvider>
  );
}

function SignInOnce({ asks }: { asks: number }) {
  const { ready, authenticated, login } = usePrivy();
  const answered = useRef(0);

  useEffect(() => {
    if (ready && !authenticated && asks > answered.current) {
      answered.current = asks;
      login();
    }
  }, [asks, ready, authenticated, login]);

  // The holder's controls live under the page's own wallet, which only mounts
  // on a device marked as returning. So the mark is written and the page loads
  // once more, and the holder lands on their controls.
  useEffect(() => {
    if (!authenticated) {
      return;
    }
    try {
      window.localStorage.setItem(RETURNING_KEY, "1");
    } catch {
      return;
    }
    window.location.reload();
  }, [authenticated]);

  return null;
}
