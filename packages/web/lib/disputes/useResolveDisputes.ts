"use client";

import { usePrivy, useSendTransaction, useWallets } from "@privy-io/react-auth";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Hex } from "viem";
import { CHAIN_ID, addresses, chain } from "@/lib/chain/client";
import { resolveCalldata, withdrawCalldata } from "@/lib/chain/calldata";
import { withdrawable } from "@/lib/chain/registry";
import { transactionHash } from "@/lib/studio/confirm";
import { ensureMonad } from "@/lib/studio/wallet";
import { confirmResolve, confirmWithdraw } from "./confirm";
import { describeFlagFailure, type FlagFailure } from "./flag";

/** What one settled dispute became, kept so the row can say so without a reload. */
export type Outcome = "upheld" | "rejected";

export interface ResolveDisputes {
  ready: boolean;
  authenticated: boolean;
  wallet?: Hex;
  /** The signed in embedded wallet is the address the policy names. */
  isResolver: boolean;
  /** What the registry owes this account, in wei. Null until it has been read. */
  credit: bigint | null;
  /** The passport being settled right now, so only its own buttons go quiet. */
  busy: Hex | null;
  /** True while the send is out and Monad is being watched. */
  confirming: boolean;
  /** Which passports this session has settled, and which way. */
  settled: Record<string, Outcome>;
  failure: FlagFailure | null;
  withdrawing: boolean;
  withdrawn: boolean;
  actions: {
    settle: (passportId: Hex, upheld: boolean) => Promise<void>;
    withdraw: () => Promise<void>;
    signIn: () => void;
  };
}

/**
 * The resolver's side of the queue: uphold a challenge, reject it, and pull
 * whatever the registry owes this account.
 *
 * The registry checks who is calling, so this hook never gates on trust: it
 * hides the buttons from anyone who is not the resolver because a button that
 * always reverts is a lie, not a safeguard.
 *
 * Nothing is pushed. resolve only records a credit, which is why the withdraw
 * button exists at all and why it is read from the chain rather than assumed.
 */
export function useResolveDisputes({
  resolver,
  onSettled,
}: {
  /** The address the policy names, read on the server and passed down. */
  resolver: Hex;
  /** Called once a dispute has left Open, so the page can re-read the queue. */
  onSettled?: () => void;
}): ResolveDisputes {
  const { ready, authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const { sendTransaction } = useSendTransaction();

  const embedded = useMemo(() => wallets.find((entry) => entry.walletClientType === "privy"), [wallets]);
  const wallet = embedded?.address as Hex | undefined;
  const isResolver = wallet !== undefined && wallet.toLowerCase() === resolver.toLowerCase();

  const [owedAnswer, setOwedAnswer] = useState<{ wallet: Hex; owed: bigint | null } | null>(null);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState<Hex | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [settled, setSettled] = useState<Record<string, Outcome>>({});
  const [failure, setFailure] = useState<FlagFailure | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawn, setWithdrawn] = useState(false);

  useEffect(() => {
    if (wallet === undefined) {
      return;
    }

    let live = true;

    void (async () => {
      const owed = await withdrawable(wallet).catch(() => null);
      if (live) {
        setOwedAnswer({ wallet, owed });
      }
    })();

    return () => {
      live = false;
    };
  }, [wallet, tick]);

  // An answer read for another wallet is not this wallet's answer.
  const credit = owedAnswer !== null && owedAnswer.wallet === wallet ? owedAnswer.owed : null;

  /** Asks the registry again what it owes. Nothing is sent. */
  const readCredit = useCallback(() => setTick((value) => value + 1), []);

  /** One write, up to the moment the wallet answers. The simulate names the revert. */
  const send = useCallback(
    async (data: Hex): Promise<Hex | undefined> => {
      if (embedded === undefined || wallet === undefined) {
        return undefined;
      }
      await ensureMonad(embedded);
      await chain.call({ account: wallet, to: addresses.registry, data });

      const answer = await sendTransaction({ to: addresses.registry, data, chainId: CHAIN_ID }, { sponsor: true });
      return transactionHash(answer.hash);
    },
    [embedded, sendTransaction, wallet],
  );

  const settle = useCallback(
    async (passportId: Hex, upheld: boolean) => {
      if (embedded === undefined || wallet === undefined) {
        return;
      }

      setFailure(null);
      setBusy(passportId);
      try {
        const hash = await send(resolveCalldata(passportId, upheld));
        setConfirming(true);
        await confirmResolve({ passportId, hash });
        setSettled((done) => ({ ...done, [passportId.toLowerCase()]: upheld ? "upheld" : "rejected" }));
        readCredit();
        onSettled?.();
      } catch (error) {
        setFailure(describeFlagFailure(error));
      } finally {
        setConfirming(false);
        setBusy(null);
      }
    },
    [embedded, onSettled, readCredit, send, wallet],
  );

  const withdraw = useCallback(async () => {
    if (embedded === undefined || wallet === undefined) {
      return;
    }

    setFailure(null);
    setWithdrawing(true);
    try {
      const owed = await withdrawable(wallet);
      setOwedAnswer({ wallet, owed });
      if (owed === 0n) {
        setFailure({ key: "nothingOwed" });
        return;
      }

      const hash = await send(withdrawCalldata());
      await confirmWithdraw({ wallet, owedBefore: owed, hash });
      setWithdrawn(true);
      readCredit();
    } catch (error) {
      setFailure(describeFlagFailure(error));
    } finally {
      setWithdrawing(false);
    }
  }, [embedded, readCredit, send, wallet]);

  return {
    ready,
    authenticated,
    wallet,
    isResolver,
    credit,
    busy,
    confirming,
    settled,
    failure,
    withdrawing,
    withdrawn,
    actions: { settle, withdraw, signIn: login },
  };
}
