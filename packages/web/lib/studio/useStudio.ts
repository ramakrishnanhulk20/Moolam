"use client";

import { usePrivy, useSendTransaction, useWallets, type ConnectedWallet } from "@privy-io/react-auth";
import { useCallback, useMemo, useReducer, useRef, useState } from "react";
import type { Hex } from "viem";
import { CHAIN_ID, addresses, chain } from "@/lib/chain/client";
import { bindPasskeyCalldata, passportInputFrom, passportInputFromGenerated, registerCalldata } from "@/lib/chain/calldata";
import { bindNonce, hashBind, hashPassport } from "@/lib/chain/registry";
import { createPasskey, rememberCredential, signDigest } from "@/lib/passkey/browser";
import { checkAuth } from "@/lib/passkey/verify";
import { VerifierError, generate, prepare } from "@/lib/verifier/client";
import { accountName, type AccountName, type SignedInUser } from "./account";
import { bindReducer, initialBindState, type BindState } from "./binding";
import { confirmBind, confirmRegister, transactionHash } from "./confirm";
import { initialRegisterState, registerReducer, type Mode, type RegisterState } from "./flow";
import { checkPrompt, generateDeadline } from "./generate";
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
  /** True while the bind is out and Monad is being watched for it. The register step carries its own flag. */
  confirming: boolean;
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
    setPrompt: (prompt: string) => void;
    setMode: (mode: Mode) => void;
    registerImage: () => Promise<void>;
    /** The agent draws and signs, then this device signs, then one transaction goes out. */
    generateImage: () => Promise<void>;
    retryUnsponsored: () => Promise<void>;
    /** Asks Monad again about a write that was accepted but has not shown up. Sends nothing. */
    recheck: () => Promise<void>;
    reset: () => void;
  };
  passports: CreatorPassports;
}

/** A send that is out, and everything a second look at the chain would need. */
type Watch =
  | {
      kind: "bind";
      wallet: Hex;
      nonceBefore: bigint;
      hash?: Hex;
      balanceBefore: bigint | null;
      credentialId: Uint8Array;
    }
  | {
      kind: "register";
      wallet: Hex;
      exactHash: Hex;
      hash?: Hex;
      balanceBefore: bigint | null;
    };

/** What a wallet answered a send with, before anything on chain is known. */
interface Submitted {
  /** Absent when the wallet answered without a usable hash, which a sponsored send does. */
  hash?: Hex;
  /** The wallet's own MON before the send, kept to prove who paid the fee. */
  balanceBefore: bigint | null;
}

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
  const [confirming, setConfirming] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [recovery, setRecovery] = useState<Failure | null>(null);

  /** The last register transaction, kept so the unsponsored retry sends the same bytes. */
  const pending = useRef<{ data: Hex; exactHash: Hex } | null>(null);
  /** The send that is out. A recheck reads it, and nothing here ever sends again. */
  const watching = useRef<Watch | null>(null);

  /**
   * One write, up to the moment the wallet answers.
   *
   * The call is simulated first: a revert costs nothing there and comes back
   * with a name the ABI can decode, where a reverted transaction on chain only
   * ever says "reverted". The hash the wallet returns is taken only when it is
   * one: Privy's sponsored path answers with an empty string while the
   * transaction is already on its way, and treating that as a failure is how a
   * landed bind gets sent a second time.
   */
  const submit = useCallback(
    async (entry: ConnectedWallet, from: Hex, data: Hex, unsponsored: boolean): Promise<Submitted> => {
      await ensureMonad(entry);
      await chain.call({ account: from, to: addresses.registry, data });

      const balanceBefore = unsponsored ? null : await chain.getBalance({ address: from });
      const answer = await sendTransaction(
        { to: addresses.registry, data, chainId: CHAIN_ID },
        { sponsor: !unsponsored },
      );

      return { hash: transactionHash(answer.hash), balanceBefore };
    },
    [sendTransaction],
  );

  /**
   * Reads the balance again once the write has landed. This is what turns
   * "Privy pays the fee" from a claim into something the screen can show.
   */
  const settleSponsorship = useCallback(async (from: Hex, balanceBefore: bigint | null) => {
    if (balanceBefore === null) {
      setSponsorship("own");
      return;
    }
    const after = await chain.getBalance({ address: from }).catch(() => null);
    setSponsorship(after !== null && after >= balanceBefore ? "proven" : "own");
  }, []);

  /**
   * Watches Monad for the bind that is out, and finishes the card when the
   * registry's own nonce says it landed. Safe to run again: it reads, it never
   * sends.
   */
  const finishBind = useCallback(async () => {
    const watch = watching.current;
    if (watch === null || watch.kind !== "bind") {
      return;
    }

    dispatchBind({ type: "stage", stage: "sending" });
    setConfirming(true);
    try {
      const landed = await confirmBind({ wallet: watch.wallet, nonceBefore: watch.nonceBefore, hash: watch.hash });
      if (landed.hash !== undefined) {
        dispatchBind({ type: "sent", txHash: landed.hash });
      }

      await settleSponsorship(watch.wallet, watch.balanceBefore);
      rememberCredential(watch.wallet, watch.credentialId);
      watching.current = null;
      dispatchBind({ type: "bound" });
      binding.refresh();
    } catch (error) {
      dispatchBind({ type: "failed", failure: describeFailure(error, "send", watch.wallet) });
    } finally {
      setConfirming(false);
    }
  }, [binding, settleSponsorship]);

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
      const sent = await submit(embedded, wallet, bindPasskeyCalldata(created.qx, created.qy, signed.auth), false);
      if (sent.hash !== undefined) {
        dispatchBind({ type: "sent", txHash: sent.hash });
      }

      watching.current = {
        kind: "bind",
        wallet,
        nonceBefore: nonce,
        hash: sent.hash,
        balanceBefore: sent.balanceBefore,
        credentialId: signed.credentialId,
      };
    } catch (error) {
      dispatchBind({ type: "failed", failure: describeFailure(error, stageOf(error), wallet) });
      return;
    }

    await finishBind();
  }, [embedded, finishBind, submit, user, wallet]);

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

  /**
   * Watches Monad for the passport that is out. The registry holding the
   * passport is the answer, and the transaction hash, when the wallet never
   * gave one, comes from the index afterwards so the receipt still links to it.
   */
  const finishRegister = useCallback(async () => {
    const watch = watching.current;
    if (watch === null || watch.kind !== "register") {
      return;
    }

    dispatchRegister({ type: "watching" });
    try {
      const landed = await confirmRegister({ exactHash: watch.exactHash, hash: watch.hash });
      if (landed.hash !== undefined) {
        dispatchRegister({ type: "sent", txHash: landed.hash });
      }
      dispatchRegister({ type: "confirmed", block: landed.blockNumber ?? null, at: landed.registeredAt ?? Date.now() });

      await settleSponsorship(watch.wallet, watch.balanceBefore);
      watching.current = null;
      passports.refresh();
    } catch (error) {
      dispatchRegister({ type: "failed", failure: describeFailure(error, "send", watch.wallet) });
    }
  }, [passports, settleSponsorship]);

  const sendRegister = useCallback(
    async (data: Hex, exactHash: Hex, unsponsored: boolean) => {
      if (embedded === undefined || wallet === undefined) {
        return;
      }

      dispatchRegister({ type: "start", step: "send", unsponsored });
      try {
        const sent = await submit(embedded, wallet, data, unsponsored);
        if (sent.hash !== undefined) {
          dispatchRegister({ type: "sent", txHash: sent.hash });
        }

        watching.current = {
          kind: "register",
          wallet,
          exactHash,
          hash: sent.hash,
          balanceBefore: sent.balanceBefore,
        };
      } catch (error) {
        const failure = describeFailure(error, "send", wallet);
        if (failure.next === "unsponsored") {
          setBalance(await chain.getBalance({ address: wallet }).catch(() => null));
        }
        dispatchRegister({ type: "failed", failure });
        return;
      }

      await finishRegister();
    },
    [embedded, finishRegister, submit, wallet],
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
      pending.current = { data, exactHash: prepared.passport.exactHash };
      dispatchRegister({ type: "signed", digest });
    } catch (error) {
      dispatchRegister({ type: "failed", failure: describeFailure(error, stageOf(error), wallet) });
      return;
    }

    await sendRegister(data, prepared.passport.exactHash, false);
  }, [binding, embedded, getAccessToken, register.file, register.title, sendRegister, wallet]);

  /**
   * The agent path, end to end.
   *
   * The service draws, pins and signs in one answer, and what comes back is
   * signed: the creator address and the deadline inside it are the agent's, so
   * the passkey signs that struct untouched and the registry sees two
   * signatures over one digest. Everything after the signing, the send, the
   * sponsorship and the wait on Monad, is the upload path's own code.
   */
  const generateImage = useCallback(async () => {
    if (embedded === undefined || wallet === undefined || binding.passkey === null) {
      return;
    }
    if (register.title.trim().length === 0) {
      dispatchRegister({ type: "failed", failure: { key: "titleMissing" } });
      return;
    }
    const badPrompt = checkPrompt(register.prompt);
    if (badPrompt !== null) {
      dispatchRegister({ type: "failed", failure: badPrompt });
      return;
    }

    const rpId = window.location.hostname;

    dispatchRegister({ type: "start", step: "draw" });
    let drawn;
    try {
      const token = await getAccessToken();
      if (token === null) {
        throw new Error("this session has no access token, so the verify service cannot be called");
      }
      drawn = await generate({
        prompt: register.prompt.trim(),
        title: register.title.trim(),
        creator: wallet,
        deadline: generateDeadline(),
        accessToken: token,
      });
      dispatchRegister({ type: "drawn", response: drawn });
    } catch (error) {
      dispatchRegister({
        type: "failed",
        failure: describeFailure(error, "prepare"),
        quota: error instanceof VerifierError ? error.quota : undefined,
      });
      return;
    }

    dispatchRegister({ type: "start", step: "sign" });
    let data: Hex;
    try {
      const input = passportInputFromGenerated(drawn.passport);
      const digest = await hashPassport(input);
      const signed = await signDigest({ rpId, digest, credentialId: binding.credentialId });
      const check = await checkAuth(signed.auth, digest, binding.passkey.qx, binding.passkey.qy);
      if (!check.ok) {
        throw new AuthCheckFailed(check.problem, check.message);
      }
      data = registerCalldata(input, signed.auth, drawn.generatorSig);
      pending.current = { data, exactHash: drawn.passport.exactHash };
      dispatchRegister({ type: "signed", digest });
    } catch (error) {
      dispatchRegister({ type: "failed", failure: describeFailure(error, stageOf(error), wallet) });
      return;
    }

    await sendRegister(data, drawn.passport.exactHash, false);
  }, [binding, embedded, getAccessToken, register.prompt, register.title, sendRegister, wallet]);

  const retryUnsponsored = useCallback(async () => {
    if (pending.current !== null) {
      await sendRegister(pending.current.data, pending.current.exactHash, true);
    }
  }, [sendRegister]);

  const recheck = useCallback(async () => {
    const watch = watching.current;
    if (watch === null) {
      return;
    }
    await (watch.kind === "bind" ? finishBind() : finishRegister());
  }, [finishBind, finishRegister]);

  return {
    ready,
    authenticated,
    account: accountName(user as SignedInUser | null),
    wallet,
    walletMissing: authenticated && embedded === undefined,
    binding,
    bind,
    confirming,
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
      setPrompt: (prompt: string) => dispatchRegister({ type: "prompt", prompt }),
      setMode: (mode: Mode) => dispatchRegister({ type: "mode", mode }),
      registerImage,
      generateImage,
      retryUnsponsored,
      recheck,
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
