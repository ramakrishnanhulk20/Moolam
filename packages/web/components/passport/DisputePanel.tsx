"use client";

import dynamic from "next/dynamic";
import type { Hex } from "viem";
import { useWalletMounted } from "@/components/providers/WalletProvider";

// The panel's own file pulls in the wallet SDK through useFlagPassport, about 173 kB of it with
// walletconnect, jose and libphonenumber underneath. Asking for it here keeps all of that in a
// chunk of its own, so a reader who never signs in downloads a passport page without any of it.
// There is nothing to render until the chunk lands, which is what a signed out reader sees anyway.
const Challenge = dynamic(() => import("./Challenge").then((module) => module.Challenge), {
  ssr: false,
  loading: () => null,
});

/**
 * The way a stranger argues with a record: put a bond behind a claim that it is
 * wrong.
 *
 * It is one line of text until somebody opens it. A record nobody has
 * challenged should not lead with an accusation. The money is real, so the
 * bond, the account's balance and who pays which part are all on the screen
 * before the button is.
 *
 * Two readers never see it: the wallet that holds the passport, which cannot
 * usefully dispute itself, and every reader of a passport that already has an
 * open challenge, because the registry refuses a second one.
 *
 * Nobody sees it before the wallet's own provider is mounted either. Privy's
 * hooks warn into the console on every render without it, and this panel is
 * blank until they answer anyway, so the hook waits for the provider.
 */
export function DisputePanel(props: { passportId: Hex; owner: Hex | null; disputeOpen: boolean }) {
  return useWalletMounted() ? <Challenge {...props} /> : null;
}
