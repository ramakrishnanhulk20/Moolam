"use client";

import { usePrivy, useSendTransaction, useWallets } from "@privy-io/react-auth";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Hex } from "viem";
import { chain, reason } from "@/lib/chain/client";
import { disputeBond, treasury as readTreasury } from "@/lib/chain/registry";
import { transactionHash } from "@/lib/studio/confirm";
import { ensureMonad } from "@/lib/studio/wallet";
import { confirmFlag } from "./confirm";
import {
  bondCheck,
  describeFlagFailure,
  flagReducer,
  flagRequest,
  initialFlagState,
  reasonFailure,
  type BondCheck,
  type FlagState,
} from "./flag";
import { takeReopen } from "./reopen";

/** One reading of the two numbers, kept with the wallet it belongs to. */
interface Numbers {
  wallet: Hex;
  bond: bigint;
  balance: bigint;
}

/** Everything the dispute panel on a passport page needs, and nothing the rest of the page reads. */
export interface FlagPassport {
  /** Privy has answered about this session. Until then the panel draws nothing. */
  ready: boolean;
  authenticated: boolean;
  /** The signed in account holds this passport, so it is shown the status and no flag button. */
  isOwner: boolean;
  wallet?: Hex;
  /** The bond the policy asks for right now, in wei. Null until it has been read. */
  bond: bigint | null;
  /** The account's own MON, in wei. Null until it has been read. */
  balance: bigint | null;
  /** Whether that balance covers that bond, and by how much it falls short. */
  check: BondCheck | null;
  /** Where a rejected challenge's bond is credited, as the policy names it now. Null until read, or when the read failed. */
  treasury: Hex | null;
  /** True while the two numbers above are being read. */
  reading: boolean;
  state: FlagState;
  actions: {
    open: () => void;
    close: () => void;
    setReason: (reason: string) => void;
    submit: () => Promise<void>;
    /** Asks Monad again about a flag that was sent and has not shown up. Sends nothing. */
    recheck: () => Promise<void>;
    signIn: () => void;
    reset: () => void;
  };
}

/**
 * One visitor's side of a dispute: put a bond behind a claim that this record
 * is wrong.
 *
 * The bond is real MON out of the visitor's own account, so both numbers are
 * read from the chain before the button is offered and again before the send:
 * what the policy asks for, and what the account holds. Privy pays the network
 * fee, and it cannot pay the bond, which is the one thing the panel says out
 * loud before anyone presses anything.
 */
export function useFlagPassport({
  passportId,
  owner,
  onLanded,
}: {
  passportId: Hex;
  owner: Hex | null;
  /** Called once the dispute is on chain, so the page can re-read what the server rendered. */
  onLanded?: () => void;
}): FlagPassport {
  const { ready, authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const { sendTransaction } = useSendTransaction();

  const embedded = useMemo(() => wallets.find((entry) => entry.walletClientType === "privy"), [wallets]);
  const wallet = embedded?.address as Hex | undefined;

  const [state, dispatch] = useReducer(flagReducer, initialFlagState);
  /** The last answer to "what does the bond cost and what does this account hold". */
  const [numbers, setNumbers] = useState<Numbers | null>(null);
  /** The bond alone, read for a reader with no wallet, so the rules still name the price. */
  const [askedBond, setAskedBond] = useState<bigint | null>(null);

  const [treasury, setTreasury] = useState<Hex | null>(null);

  // A first sign-in reloads the page with the wallet up, and the panel that
  // asked for it opens itself again, so the form lands where the press was.
  useEffect(() => {
    if (takeReopen(passportId)) {
      dispatch({ type: "open" });
    }
  }, [passportId]);

  /** The flag that is out, so a recheck can look again without sending a second one. */
  const watching = useRef<{ challenger: Hex; hash?: Hex } | null>(null);

  const isOwner = owner !== null && wallet !== undefined && owner.toLowerCase() === wallet.toLowerCase();

  /** The bond and the balance, together, because the panel only ever shows them against each other. */
  const readNumbers = useCallback(async (): Promise<{ bond: bigint; balance: bigint } | null> => {
    if (wallet === undefined) {
      return null;
    }
    const [asked, held] = await Promise.all([disputeBond(), chain.getBalance({ address: wallet })]);
    setNumbers({ wallet, bond: asked, balance: held });
    return { bond: asked, balance: held };
  }, [wallet]);

  useEffect(() => {
    if (!state.open || wallet === undefined || isOwner) {
      return;
    }

    let live = true;

    void (async () => {
      try {
        const [asked, held] = await Promise.all([disputeBond(), chain.getBalance({ address: wallet })]);
        if (live) {
          setNumbers({ wallet, bond: asked, balance: held });
        }
      } catch (thrown) {
        // Without both numbers the panel cannot honestly offer the button, so the
        // reason is printed where every other failure is printed.
        if (live) {
          dispatch({ type: "failed", failure: { key: "unknown", reason: reason(thrown) }, stage: "account" });
        }
      }
    })();

    return () => {
      live = false;
    };
  }, [isOwner, state.open, wallet]);

  // Signed out there is no balance to read against the bond, and the rules
  // still name the price, so the bond is read on its own.
  useEffect(() => {
    if (!state.open || wallet !== undefined) {
      return;
    }
    let live = true;
    void disputeBond()
      .then((asked) => {
        if (live) {
          setAskedBond(asked);
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [state.open, wallet]);

  // The bond's fate is a line of its own under the rules, so a treasury that
  // cannot be read costs that line and nothing else.
  useEffect(() => {
    if (!state.open || isOwner) {
      return;
    }
    let live = true;
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
  }, [isOwner, state.open]);

  // An answer read for another wallet is not this wallet's answer. The bond is
  // the same number for everybody, so the one read without a wallet stands in
  // until this wallet's own pair arrives.
  const current = numbers !== null && numbers.wallet === wallet ? numbers : null;
  const bond = current?.bond ?? askedBond;
  const balance = current?.balance ?? null;

  /** Watches Monad for the flag that is out. Safe to run again: it reads, it never sends. */
  const finish = useCallback(async () => {
    const out = watching.current;
    if (out === null) {
      return;
    }
    try {
      const landed = await confirmFlag({ passportId, challenger: out.challenger, hash: out.hash });
      watching.current = null;
      dispatch({ type: "recorded", block: landed.blockNumber ?? null });
      await readNumbers().catch(() => null);
      onLanded?.();
    } catch (error) {
      const failure = describeFlagFailure(error);
      // A wait that ran out keeps the watch: the flag may already be on chain,
      // so the only thing left to offer is another look. Anything else was a
      // send that did not happen, and the button is free again.
      if (failure.key !== "confirmPending") {
        watching.current = null;
      }
      dispatch({ type: "failed", failure, stage: "send" });
    }
  }, [onLanded, passportId, readNumbers]);

  const submit = useCallback(async () => {
    if (embedded === undefined || wallet === undefined) {
      return;
    }

    // A flag that is out and unconfirmed is never sent a second time. The
    // recheck is the only thing that moves this on.
    if (watching.current !== null) {
      return;
    }

    const badReason = reasonFailure(state.reason);
    if (badReason !== null) {
      dispatch({ type: "failed", failure: badReason, stage: "account" });
      return;
    }

    dispatch({ type: "start" });

    let request;
    try {
      // Both numbers are read again here rather than trusted from the panel: the
      // policy's bond can change under a page that has been open a while, and the
      // registry refuses anything that is not exactly it.
      const numbers = await readNumbers();
      if (numbers === null) {
        throw new Error("this session has no embedded wallet, so the bond cannot be read");
      }
      const check = bondCheck(numbers.balance, numbers.bond);
      if (check !== null && !check.enough) {
        dispatch({
          type: "failed",
          failure: { key: "notEnough", shortfall: check.shortfall },
          stage: "account",
        });
        return;
      }

      request = flagRequest({ passportId, reason: state.reason, bond: numbers.bond });
      await ensureMonad(embedded);
      // A revert costs nothing here and comes back with a name the ABI can decode,
      // where a reverted transaction on chain only ever says "reverted".
      await chain.call({ account: wallet, to: request.to, data: request.data, value: request.value });
    } catch (error) {
      dispatch({ type: "failed", failure: describeFlagFailure(error), stage: "account" });
      return;
    }

    try {
      const answer = await sendTransaction(
        { to: request.to, data: request.data, value: request.value, chainId: request.chainId },
        // The wallet the call was simulated for, named out loud: a session with
        // more than one wallet must not send this from a different account.
        { sponsor: true, address: wallet },
      );
      const hash = transactionHash(answer.hash);
      dispatch({ type: "sent", hash });
      watching.current = { challenger: wallet, hash };
    } catch (error) {
      dispatch({ type: "failed", failure: describeFlagFailure(error), stage: "account" });
      return;
    }

    await finish();
  }, [embedded, finish, passportId, readNumbers, sendTransaction, state.reason, wallet]);

  return {
    ready,
    authenticated,
    isOwner,
    wallet,
    bond,
    balance,
    check: bondCheck(balance, bond),
    treasury,
    reading: state.open && !isOwner && wallet !== undefined && current === null && state.failure === null,
    state,
    actions: {
      open: () => dispatch({ type: "open" }),
      close: () => dispatch({ type: "close" }),
      setReason: (reason: string) => dispatch({ type: "reason", reason }),
      submit,
      recheck: finish,
      signIn: login,
      reset: () => dispatch({ type: "reset" }),
    },
  };
}
