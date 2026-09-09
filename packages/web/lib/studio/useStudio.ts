"use client";

import { usePrivy, useSendTransaction, useWallets, type ConnectedWallet } from "@privy-io/react-auth";
import { useCallback, useMemo, useReducer, useRef, useState } from "react";
import type { Hex } from "viem";
import { CHAIN_ID, addresses, chain } from "@/lib/chain/client";
import { bindPasskeyCalldata, passportInputFrom, registerCalldata } from "@/lib/chain/calldata";
import { bindNonce, hashBind, hashPassport } from "@/lib/chain/registry";
import { createPasskey, rememberCredential, signDigest } from "@/lib/passkey/browser";
import { checkAuth } from "@/lib/passkey/verify";
import { prepare } from "@/lib/verifier/client";
import { accountName, type AccountName, type SignedInUser } from "./account";
import { bindReducer, initialBindState, type BindState } from "./binding";
import { initialRegisterState, registerReducer, type RegisterState } from "./flow";
import { AuthCheckFailed, describeFailure, type Failure } from "./problems";
import { useCreatorPassports, type CreatorPassports } from "./useCreatorPassports";
import { usePasskeyBinding, type Binding } from "./usePasskeyBinding";
import { ensureMonad } from "./wallet";

/**
 * Who pays the network fee, as far as this session has proved.
 *
 * It starts as a claim, that Privy is set up to pay, and only becomes a fact
 * once a transaction has landed and the wallet's balance has not moved. A judge
 * should be able to tell those two apart on screen.
 */
export type Sponsorship = "claimed" | "proven" | "own";

export interface Studio {
  ready: boolean;
  authenticated: boolean;
  account: AccountName;
  wallet: Hex | undefined;
  walletMissing: boolean;
  binding: Binding;
  bind: BindState;
  register: RegisterState;
  sponsorship: Sponsorship;
  /** The wallet's own MON, read only when a sponsored send was refused. */
  balance: bigint | null;
  recovering: boolean;
  recovery: Failure | null;
  login: () => void;
  logout: () => void;
  actions: {
    bindThisDevice: () => Promise<void>;
    recoverThisDevice: () => Promise<void>;
    choose: (file: File) => void;
    setTitle: (title: string) => void;
    registerImage: () => Promise<void>;
    retryUnsponsored: () => Promise<void>;
    reset: () => void;
  };
  passports: CreatorPassports;
}

/** A transaction that has been mined, with the block a receipt can point at. */
interface Landed {
  hash: Hex;
  block: bigint;
}

/** How long to wait for Monad to mine a transaction before saying so out loud. */
const RECEIPT_TIMEOUT_MS = 90_000;

export function useStudio(): Studio {
  const { ready, authenticated, user, login, logout, getAccessToken } = usePrivy();
  const { wallets } = useWallets();
  const { sendTransaction } = useSendTransaction();

  const embedded = useMemo(() => wallets.find((entry) => entry.walletClientType === "privy"), [wallets]);
  const wallet = embedded?.address as Hex | undefined;

  const binding = usePasskeyBinding(authenticated ? wallet : undefined);
  const passports = useCreatorPassports(authenticated ? wallet : undefined);

  const [bind, dispatchBind] = useReducer(bindReducer, initialBindState);
  const [register, dispatchRegister] = useReducer(registerReducer, initialRegisterState);
  const [sponsorship, setSponsorship] = useState<Sponsorship>("claimed");
  const [balance, setBalance] = useState<bigint | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [recovery, setRecovery] = useState<Failure | null>(null);

  /** The last register transaction, kept so the unsponsored retry sends the same bytes. */
  const pending = useRef<Hex | null>(null);

  /**
   * One write, from the chain switch to the mined receipt.
   *
   * The call is simulated first: a revert costs nothing there and comes back
   * with a name the ABI can decode, where a reverted transaction on chain only
   * ever says "reverted". The balance is read either side of a sponsored send,
   * which is what turns "Privy pays the fee" from a claim into something the
   * screen can show.
   */
  const sendWrite = useCallback(
    async (entry: ConnectedWallet, from: Hex, data: Hex, unsponsored: boolean): Promise<Landed> => {
      await ensureMonad(entry);
      await chain.call({ account: from, to: addresses.registry, data });

      const before = unsponsored ? null : await chain.getBalance({ address: from });
      const { hash } = await sendTransaction(
        { to: addresses.registry, data, chainId: CHAIN_ID },
        { sponsor: !unsponsored },
      );

      const receipt = await chain.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
      if (receipt.status !== "success") {
        throw new Error(`Monad mined this transaction and it reverted: ${hash}`);
      }

      if (unsponsored) {
        setSponsorship("own");
      } else if (before !== null) {
        const after = await chain.getBalance({ address: from });
        setSponsorship(after >= before ? "proven" : "own");
      }

      return { hash, block: receipt.blockNumber };
    },
    [sendTransaction],
  );

  const bindThisDevice = useCallback(async () => {
    if (embedded === undefined || wallet === undefined) {
      return;
    }

    const rpId = window.location.hostname;
    dispatchBind({ type: "stage", stage: "creating" });

    try {
      const created = await createPasskey({
        rpId,
        wallet,
        displayName: accountName(user as SignedInUser | null).value ?? wallet,
      });
      dispatchBind({ type: "created", qx: created.qx, qy: created.qy });

      const nonce = await bindNonce(wallet);
      const digest = await hashBind(wallet, created.qx, created.qy, nonce);

      const signed = await signDigest({ rpId, digest, credentialId: created.credentialId });
      const check = await checkAuth(signed.auth, digest, created.qx, created.qy);
      if (!check.ok) {
        throw new AuthCheckFailed(check.problem, check.message);
      }

      dispatchBind({ type: "stage", stage: "sending" });
      const landed = await sendWrite(embedded, wallet, bindPasskeyCalldata(created.qx, created.qy, signed.auth), false);
      dispatchBind({ type: "sent", txHash: landed.hash });

      rememberCredential(wallet, signed.credentialId);
      dispatchBind({ type: "bound" });
      binding.refresh();
    } catch (error) {
      dispatchBind({ type: "failed", failure: describeFailure(error, stageOf(error)) });
    }
  }, [binding, embedded, sendWrite, user, wallet]);

  /**
   * The second device. The passkey signs a throwaway challenge with no
   * credential filter, and the answer is checked against the key the chain
   * already holds, so the browser learns whether this device carries the bound
   * passkey without spending a transaction to find out.
   */
  const recoverThisDevice = useCallback(async () => {
    if (wallet === undefined || binding.passkey === null) {
      return;
    }

    setRecovering(true);
    setRecovery(null);

    try {
      const digest = randomDigest();
      const signed = await signDigest({ rpId: window.location.hostname, digest });
      const check = await checkAuth(signed.auth, digest, binding.passkey.qx, binding.passkey.qy);
      if (!check.ok) {
        throw new AuthCheckFailed(check.problem, check.message);
      }

      rememberCredential(wallet, signed.credentialId);
      binding.remember(signed.credentialId);
    } catch (error) {
      setRecovery(describeFailure(error, "passkey"));
    } finally {
      setRecovering(false);
    }
  }, [binding, wallet]);

  const sendRegister = useCallback(
    async (data: Hex, unsponsored: boolean) => {
      if (embedded === undefined || wallet === undefined) {
        return;
      }

      dispatchRegister({ type: "start", step: "send", unsponsored });
      try {
        const landed = await sendWrite(embedded, wallet, data, unsponsored);
        dispatchRegister({ type: "sent", txHash: landed.hash });
        dispatchRegister({ type: "confirmed", block: landed.block, at: Date.now() });
        passports.refresh();
      } catch (error) {
        const failure = describeFailure(error, "send");
        if (failure.next === "unsponsored") {
          setBalance(await chain.getBalance({ address: wallet }).catch(() => null));
        }
        dispatchRegister({ type: "failed", failure });
      }
    },
    [embedded, passports, sendWrite, wallet],
  );

  const registerImage = useCallback(async () => {
    if (embedded === undefined || wallet === undefined || binding.passkey === null) {
      return;
    }
    if (register.file === null) {
      dispatchRegister({ type: "failed", failure: { key: "fileMissing" } });
      return;
    }
    if (register.title.trim().length === 0) {
      dispatchRegister({ type: "failed", failure: { key: "titleMissing" } });
      return;
    }

    const rpId = window.location.hostname;

    dispatchRegister({ type: "start", step: "prepare" });
    let prepared;
    try {
      const token = await getAccessToken();
      if (token === null) {
        throw new Error("this session has no access token, so the verify service cannot be called");
      }
      prepared = await prepare({ file: register.file, title: register.title.trim(), accessToken: token });
      dispatchRegister({ type: "prepared", prepared });
    } catch (error) {
      dispatchRegister({ type: "failed", failure: describeFailure(error, "prepare") });
      return;
    }

    dispatchRegister({ type: "start", step: "sign" });
    let data: Hex;
    try {
      const input = passportInputFrom(prepared.passport, wallet);
      const digest = await hashPassport(input);
      const signed = await signDigest({ rpId, digest, credentialId: binding.credentialId });
      const check = await checkAuth(signed.auth, digest, binding.passkey.qx, binding.passkey.qy);
      if (!check.ok) {
        throw new AuthCheckFailed(check.problem, check.message);
      }
      data = registerCalldata(input, signed.auth, "0x");
      pending.current = data;
      dispatchRegister({ type: "signed", digest });
    } catch (error) {
      dispatchRegister({ type: "failed", failure: describeFailure(error, stageOf(error)) });
      return;
    }

    await sendRegister(data, false);
  }, [binding, embedded, getAccessToken, register.file, register.title, sendRegister, wallet]);

  const retryUnsponsored = useCallback(async () => {
    if (pending.current !== null) {
      await sendRegister(pending.current, true);
    }
  }, [sendRegister]);

  return {
    ready,
    authenticated,
    account: accountName(user as SignedInUser | null),
    wallet,
    walletMissing: authenticated && embedded === undefined,
    binding,
    bind,
    register,
    sponsorship,
    balance,
    recovering,
    recovery,
    login,
    logout,
    actions: {
      bindThisDevice,
      recoverThisDevice,
      choose: (file: File) => dispatchRegister({ type: "choose", file }),
      setTitle: (title: string) => dispatchRegister({ type: "title", title }),
      registerImage,
      retryUnsponsored,
      reset: () => dispatchRegister({ type: "reset" }),
    },
    passports,
  };
}

/**
 * Which half of a bind the error came from. Anything the passkey ceremony
 * throws carries a DOMException name; everything else at that point is a chain
 * read or the transaction itself.
 */
function stageOf(error: unknown): "passkey" | "send" {
  if (error instanceof AuthCheckFailed) {
    return "passkey";
  }
  const name = error instanceof Error ? error.name : "";
  if (name === "PasskeyUnsupported") {
    return "passkey";
  }
  return name.endsWith("Error") && name !== "Error" ? "passkey" : "send";
}

function randomDigest(): Hex {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
