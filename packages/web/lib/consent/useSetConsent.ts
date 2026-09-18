"use client";

import { usePrivy, useSendTransaction, useWallets } from "@privy-io/react-auth";
import { useCallback, useMemo, useRef, useState } from "react";
import type { Hex } from "viem";
import { chain, consentAbi } from "@/lib/chain/client";
import { getConsent } from "@/lib/chain/consent";
import { useRouter } from "@/lib/i18n/routing";
import { refreshPassport } from "@/lib/passport/refresh";
import { transactionHash } from "@/lib/studio/confirm";
import { ensureMonad } from "@/lib/studio/wallet";
import { consentStruct, opensAt, setConsentRequest, type ConsentDraft } from "./call";
import { confirmSetConsent } from "./confirm";
import { describeConsentFailure, type ConsentFailure } from "./failure";

/** What the statement is doing right now. "confirming" is out and unconfirmed: never sent again. */
export type ConsentStep = "idle" | "checking" | "sending" | "confirming" | "done";

export interface ConsentSendState {
  step: ConsentStep;
  hash?: Hex;
  /** When the register says the statement was written, in whole seconds. */
  at: number | null;
  failure: ConsentFailure | null;
}

export interface SetConsent {
  /** Privy has answered about this session. Until then the control draws nothing. */
  ready: boolean;
  authenticated: boolean;
  /** The signed in wallet is the one the registry says holds this passport. */
  isHolder: boolean;
  wallet?: Hex;
  /**
   * The second this wallet may write for this passport again, or null when it
   * may write now. The control locks itself on this rather than paying for a
   * TooSoon revert to find out.
   */
  opensAt: number | null;
  /** True while a statement is out: nothing may start a second one. */
  busy: boolean;
  state: ConsentSendState;
  actions: {
    submit: (draft: ConsentDraft) => Promise<void>;
    /** Asks Monad again about a statement that was sent and has not shown up. Sends nothing. */
    recheck: () => Promise<void>;
    signIn: () => void;
    reset: () => void;
  };
}

const IDLE: ConsentSendState = { step: "idle", at: null, failure: null };

/**
 * The holder's side of the consent register: say how AI may use this picture,
 * from the page the picture is on.
 *
 * Only the wallet the registry says holds the passport can write, which the
 * contract checks inside the same call, so the control is drawn for one reader
 * and the send is simulated against the register before anything is signed. The
 * fee is Privy's; the statement is the holder's.
 *
 * Nothing here trusts the hash a sponsored send answers with. The statement is
 * confirmed by reading the register back until it holds these four values from
 * this wallet, and only then is the page's hold on this passport dropped and
 * the page asked to read itself again.
 */
export function useSetConsent({
  passportId,
  owner,
  standing,
  minInterval,
}: {
  passportId: Hex;
  owner: Hex | null;
  /** The statement that stands, as the page read it on the server. */
  standing: { writer?: string; at?: number };
  /** The register's own waiting rule, in seconds. */
  minInterval: number;
}): SetConsent {
  const { ready, authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const { sendTransaction } = useSendTransaction();
  const router = useRouter();

  const embedded = useMemo(() => wallets.find((entry) => entry.walletClientType === "privy"), [wallets]);
  const wallet = embedded?.address as Hex | undefined;

  const [state, setState] = useState<ConsentSendState>(IDLE);

  /** The statement that is out, so a recheck can look again without sending a second one. */
  const watching = useRef<{ wallet: Hex; sent: ConsentDraft; since: number; hash?: Hex } | null>(null);

  const isHolder = owner !== null && wallet !== undefined && owner.toLowerCase() === wallet.toLowerCase();

  /** Watches Monad for the statement that is out. Safe to run again: it reads, it never sends. */
  const finish = useCallback(async () => {
    const out = watching.current;
    if (out === null) {
      return;
    }

    try {
      const landed = await confirmSetConsent({
        passportId,
        wallet: out.wallet,
        sent: out.sent,
        since: out.since,
        hash: out.hash,
      });
      watching.current = null;
      setState({ step: "done", hash: out.hash, at: landed.at, failure: null });

      // The section around this control is server rendered and held for a
      // minute, so what is held about this passport goes first. Without that
      // the re-read would hand the holder back the statement they just replaced.
      await refreshPassport(passportId);
      router.refresh();
    } catch (error) {
      const failure = describeConsentFailure(error);
      // A wait that ran out keeps the watch: the statement may already be on
      // chain, so the only thing left to offer is another look.
      if (failure.key !== "confirmPending") {
        watching.current = null;
      }
      setState((was) => ({ ...was, step: failure.key === "confirmPending" ? "confirming" : "idle", failure }));
    }
  }, [passportId, router]);

  const submit = useCallback(
    async (draft: ConsentDraft) => {
      if (embedded === undefined || wallet === undefined || watching.current !== null) {
        return;
      }

      setState({ step: "checking", at: null, failure: null });

      let since = 0;
      let request;
      try {
        // Read again rather than trusted from the page: a statement written
        // from another tab a minute ago would make this one TooSoon, and the
        // second it stood from is what the confirmation waits past.
        const latest = await getConsent(passportId);
        const entry = latest.entry;
        since = entry === null ? 0 : Number(entry.at);

        const opens = opensAt({ writer: entry?.writer, wallet, at: entry === null ? undefined : since, minInterval });
        if (opens !== null && opens > Math.floor(Date.now() / 1000)) {
          setState({ step: "idle", at: null, failure: { key: "tooSoon", at: opens } });
          return;
        }

        request = setConsentRequest(passportId, draft);
        await ensureMonad(embedded);
        // A revert costs nothing here and comes back with a name the ABI can
        // decode, where a reverted transaction on chain only ever says
        // "reverted".
        await chain.simulateContract({
          address: request.to,
          abi: consentAbi,
          functionName: "setConsent",
          args: [passportId, consentStruct(draft.consent), draft.constraintInfo],
          account: wallet,
        });
      } catch (error) {
        setState({ step: "idle", at: null, failure: describeConsentFailure(error) });
        return;
      }

      try {
        setState({ step: "sending", at: null, failure: null });
        const answer = await sendTransaction(
          { to: request.to, data: request.data, chainId: request.chainId },
          // The wallet the call was simulated for, named out loud: a session
          // with more than one wallet must not send this from a different one.
          { sponsor: true, address: wallet },
        );
        const hash = transactionHash(answer.hash);
        watching.current = { wallet, sent: draft, since, hash };
        setState({ step: "confirming", hash, at: null, failure: null });
      } catch (error) {
        setState({ step: "idle", at: null, failure: describeConsentFailure(error) });
        return;
      }

      await finish();
    },
    [embedded, finish, minInterval, passportId, sendTransaction, wallet],
  );

  return {
    ready,
    authenticated,
    isHolder,
    wallet,
    opensAt: opensAt({ writer: standing.writer, wallet, at: standing.at, minInterval }),
    // Read off the step rather than off the watch, which is a ref and belongs
    // to the send rather than to what is drawn. "confirming" is the step a
    // statement that is out and unshown stays on, so the control stays locked.
    busy: state.step === "checking" || state.step === "sending" || state.step === "confirming",
    state,
    actions: {
      submit,
      recheck: finish,
      signIn: login,
      reset: () => {
        if (watching.current === null) {
          setState(IDLE);
        }
      },
    },
  };
}
