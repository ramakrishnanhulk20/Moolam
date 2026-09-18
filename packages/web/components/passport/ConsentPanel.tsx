"use client";

import dynamic from "next/dynamic";
import type { Hex } from "viem";
import type { LedgerAnswer } from "@/components/consent/ledger";
import { useWalletMounted } from "@/components/providers/WalletProvider";

// The panel's own file pulls in the wallet SDK through useSetConsent, about 173 kB of it with
// walletconnect, jose and libphonenumber underneath. Asking for it here keeps all of that in a
// chunk of its own, so a reader who never signs in downloads a passport page without any of it.
// There is nothing to render until the chunk lands, which is what a signed out reader sees anyway.
const ConsentEditor = dynamic(() => import("./ConsentEditor").then((module) => module.ConsentEditor), {
  ssr: false,
  loading: () => null,
});

/**
 * The holder's control under the statement: say how AI may use this picture, and
 * write it to Monad from the page the picture is on.
 *
 * It is drawn for one reader only, the wallet the registry says holds this
 * passport, which is the same rule the contract itself enforces inside the call.
 * A signed out visitor and a signed in stranger get no markup at all, not a
 * disabled button: a statement they could never write is not worth the space on
 * a page about somebody else's picture.
 *
 * The hook waits for the wallet's own provider. Privy's hooks warn into the
 * console on every render that happens without it, and this panel is blank until
 * they answer anyway.
 */
export function ConsentPanel(props: {
  passportId: Hex;
  owner: Hex | null;
  /** The statement that stands, in whole numbers: a bigint cannot cross into a browser component. */
  standing: LedgerAnswer;
  /** The register's own waiting rule, in seconds, read from the contract. */
  minInterval: number;
}) {
  return useWalletMounted() ? <ConsentEditor {...props} /> : null;
}
