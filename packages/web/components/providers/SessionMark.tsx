"use client";

import { usePrivy } from "@privy-io/react-auth";
import { useEffect } from "react";
import { RETURNING_KEY } from "./WalletProvider";

/**
 * Remembers on this device that someone has signed in here.
 *
 * A passport only fetches the wallet SDK for a device carrying this mark, so
 * without it a creator who signs in on the studio would come back to a passport
 * with no edit panel. It sits under the SDK's own provider, which is the only
 * place usePrivy answers, and writes nothing to the screen.
 *
 * The mark is cleared on sign out, but only once ready is true: before that the
 * SDK has not looked for a session yet and authenticated false means "still
 * looking", which would wipe the mark of a signed in creator on every load.
 *
 * Storage can refuse (private windows, blocked site data). Then the device is
 * treated as new every time: a passport on it never fetches the wallet, so its
 * writing panels stay hidden there, while the studio and the resolve console
 * still load the wallet and signing in keeps working.
 */
export function SessionMark() {
  const { ready, authenticated } = usePrivy();

  useEffect(() => {
    try {
      if (authenticated) {
        window.localStorage.setItem(RETURNING_KEY, "1");
      } else if (ready) {
        window.localStorage.removeItem(RETURNING_KEY);
      }
    } catch {
      // Nothing to do and nothing to tell the reader: the page works either way.
    }
  }, [ready, authenticated]);

  return null;
}
