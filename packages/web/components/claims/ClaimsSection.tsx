"use client";

import { usePrivy } from "@privy-io/react-auth";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Hex } from "viem";
import { sessionEmails } from "@/lib/claims/offers";
import type { ConfirmRow } from "@/lib/claims/useClaimConfirm";
import { useClaims } from "@/lib/claims/useClaims";
import { usePendingConfirm, type PendingGroup } from "@/lib/claims/usePendingConfirm";
import { rereadHeldPassports } from "@/components/mine/held";
import type { SignedInUser } from "@/lib/studio/account";
import { ClaimsView, type ConfirmedNow } from "./ClaimsView";
import { ReadFailed } from "./ReadFailed";

/** When the held list is read again after a confirm: at once, then after the index has had time to catch up. */
const REREAD_AFTER_MS = [0, 30_000, 90_000];

// The wallet send and its receipt checks arrive only once a platform has handed something over.
const ClaimConfirm = dynamic(() => import("./ClaimConfirm").then((module) => module.ClaimConfirm));

/**
 * "Waiting for you" on My pictures, wired to the verify service and the chain
 * for the signed-in wallet. Draws nothing until the list arrives, and nothing
 * when the list is empty or the service has its claim routes closed: the grid
 * under it is the page. A list that could not be read for any other reason
 * leaves one quiet line with a way to read it again, because a person a
 * platform sent here must not meet a silent blank.
 */
export function ClaimsSection({ wallet }: { wallet: Hex }) {
  const { getAccessToken, user, login, authenticated } = usePrivy();
  const claims = useClaims({ getToken: getAccessToken, signIn: login, signedIn: authenticated, account: user });
  const pending = usePendingConfirm(claims.answer, wallet);
  const [confirmedNow, setConfirmedNow] = useState<ConfirmedNow[]>([]);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(
    () => () => {
      for (const timer of timers.current) clearTimeout(timer);
    },
    [],
  );

  // The confirmed pictures move from "made by others" to the person's own once the index shows the terms, which it does a little after the chain.
  const rereadHeldLater = useCallback(() => {
    timers.current.push(...REREAD_AFTER_MS.map((after) => setTimeout(rereadHeldPassports, after)));
  }, []);

  const renderConfirm = useCallback(
    (group: PendingGroup) => (
      <ClaimConfirm
        key={group.key}
        group={group}
        wallet={wallet}
        onReread={pending.reread}
        onDone={(txHash: Hex, rows: ConfirmRow[]) => {
          setConfirmedNow((was) => [...was.filter((one) => one.key !== group.key), { key: group.key, terms: group.terms, txHash, rows }]);
          rereadHeldLater();
        }}
      />
    ),
    [pending.reread, rereadHeldLater, wallet],
  );

  if (claims.answer === null) {
    return claims.refusal === null ? null : (
      <ReadFailed
        refusal={claims.refusal}
        reading={claims.status === "reading"}
        onAgain={claims.actions.reload}
        onSignIn={claims.actions.signIn}
      />
    );
  }

  return (
    <ClaimsView
      answer={claims.answer}
      emails={sessionEmails(user as SignedInUser | null)}
      busy={claims.busy}
      failures={claims.failures}
      refusal={claims.refusal}
      watching={claims.watching}
      pending={pending}
      confirmedNow={confirmedNow}
      renderConfirm={renderConfirm}
      onMine={(key, draft, sendFuture) => void claims.actions.mine(key, draft, sendFuture)}
      onNotMine={(key) => void claims.actions.notMine(key)}
      onStop={(key) => void claims.actions.stop(key)}
      onUnmute={(key) => void claims.actions.unmute(key)}
      onReload={claims.actions.reload}
      onReread={pending.reread}
      onSignIn={claims.actions.signIn}
    />
  );
}
