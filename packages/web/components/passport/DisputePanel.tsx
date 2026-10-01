"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import type { Hex } from "viem";
import { useWalletMounted } from "@/components/providers/WalletProvider";
import { disputeBond, treasury as readTreasury } from "@/lib/chain/registry";
import { rememberReopen } from "@/lib/disputes/reopen";
import { isPrivyConfigured } from "@/lib/env";
import { ChallengeFrame, ChallengeOpening, Rules, SignInToChallenge } from "./ChallengeRules";

// The panel's own file pulls in the wallet SDK through useFlagPassport, about 173 kB of it with
// walletconnect, jose and libphonenumber underneath. Asking for it here keeps all of that in a
// chunk of its own, so a reader who never signs in downloads a passport page without any of it.
// There is nothing to render until the chunk lands, which is what a signed out reader sees anyway.
const Challenge = dynamic(() => import("./Challenge").then((module) => module.Challenge), {
  ssr: false,
  loading: () => null,
});

// The one sign-in a device that never signed in can make from this page, in a chunk of its own
// for the same reason: it brings its own wallet provider for the length of the sign-in.
const SignInHere = dynamic(() => import("./OwnerHintWallet").then((module) => module.SignInHere), {
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
 * Two readers never see the form: the wallet that holds the passport, which
 * cannot usefully dispute itself, and every reader of a passport that already
 * has an open challenge, because the registry refuses a second one. Everyone
 * else may read what a challenge needs and who decides it, with an account or
 * without one.
 *
 * The wallet's own provider is mounted only on a device that has signed in
 * before, and Privy's hooks warn into the console on every render without it.
 * So the form waits for the provider, and a device without one gets the rules
 * from here, with Sign in to challenge bringing a provider for one sign-in.
 */
export function DisputePanel(props: { passportId: Hex; owner: Hex | null; disputeOpen: boolean }) {
  return useWalletMounted() ? (
    <Challenge {...props} />
  ) : (
    <StrangerChallenge passportId={props.passportId} disputeOpen={props.disputeOpen} />
  );
}

/**
 * The rules and who decides, for a device with no wallet mounted. The bond and
 * the treasury are the same two chain reads the form makes, so the price and
 * the bond's fate read the same here as there.
 */
function StrangerChallenge({ passportId, disputeOpen }: { passportId: Hex; disputeOpen: boolean }) {
  const [open, setOpen] = useState(false);
  const [bond, setBond] = useState<bigint | null>(null);
  const [treasury, setTreasury] = useState<Hex | null>(null);
  const [asks, setAsks] = useState(0);

  useEffect(() => {
    if (!open) {
      return;
    }
    let live = true;
    void disputeBond()
      .then((asked) => {
        if (live) {
          setBond(asked);
        }
      })
      .catch(() => undefined);
    void readTreasury()
      .then((address) => {
        if (live) {
          setTreasury(address);
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [open]);

  if (disputeOpen) {
    return null;
  }

  return (
    <>
      {asks > 0 ? <SignInHere asks={asks} /> : null}
      <ChallengeFrame open={open} onToggle={() => setOpen((was) => !was)}>
        <ChallengeOpening bond={bond} />
        <Rules treasury={treasury} />
        {isPrivyConfigured ? (
          <SignInToChallenge
            onSignIn={() => {
              // The sign-in reloads the page with the wallet up; the panel opens itself again there.
              rememberReopen(passportId);
              setAsks((count) => count + 1);
            }}
          />
        ) : null}
      </ChallengeFrame>
    </>
  );
}
