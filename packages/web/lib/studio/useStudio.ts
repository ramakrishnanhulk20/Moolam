"use client";

import { usePrivy, useSendTransaction, useWallets, type ConnectedWallet } from "@privy-io/react-auth";
import { useCallback, useMemo, useReducer, useRef, useState } from "react";
import type { Hex } from "viem";
import { CHAIN_ID, addresses, chain } from "@/lib/chain/client";
import {
  SIGNATURE_WINDOW_SECONDS,
  bindPasskeyCalldata,
  passportInputFrom,
  passportInputFromGenerated,
  registerCalldata,
} from "@/lib/chain/calldata";
import { assertDigestMatches, localBindDigest, localPassportDigest } from "@/lib/chain/digest";
import { bindNonce, getPassport, hashBind, hashPassport } from "@/lib/chain/registry";
import { deadlineFromChain } from "@/lib/chain/time";
import { createPasskey, rememberCredential, signDigest } from "@/lib/passkey/browser";
import { checkAuth } from "@/lib/passkey/verify";
import { VerifierError, generate, prepare } from "@/lib/verifier/client";
import { accountName, type AccountName, type SignedInUser } from "./account";
import { bindReducer, initialBindState, type BindState } from "./binding";
import { confirmBind, confirmRegister, transactionHash } from "./confirm";
import { initialRegisterState, registerReducer, type Mode, type RegisterState } from "./flow";
import { checkPrompt } from "./generate";
import { AuthCheckFailed, describeFailure, isResendable, type Failure } from "./problems";
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
    /** Sends the bytes that were already signed, once more. No passkey prompt, no new picture. */
    resend: (unsponsored: boolean) => Promise<void>;
    /** Asks Monad again about a write that was accepted but has not shown up. Sends nothing. */
    recheck: () => Promise<void>;
    /** Puts the bind card back to its opening state, for a creator who walks into it a second time. */
    clearBind: () => void;
    reset: () => void;
  };
  passports: CreatorPassports;
}

/** A send that is out, and everything a second look at the chain would need. */
type Watch =
  | {
      kind: "bind";
      wallet: Hex;
      qx: Hex;
      qy: Hex;
      nonceBefore: bigint;
      hash?: Hex;
      balanceBefore: bigint | null;
      credentialId: Uint8Array;
    }
  | {
      kind: "register";
      wallet: Hex;
      exactHash: Hex;
      registeredBefore?: bigint;
      hash?: Hex;
      balanceBefore: bigint | null;
    };

/** Bytes a passkey has already signed, kept so a refused send can go out again untouched. */
type Pending =
  | { kind: "bind"; data: Hex; qx: Hex; qy: Hex; nonceBefore: bigint; credentialId: Uint8Array }
  | { kind: "register"; data: Hex; exactHash: Hex };

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

  /** The last signed transaction, kept so a resend sends the same bytes. */
  const pending = useRef<Pending | null>(null);
  /** The send that is out. A recheck reads it, and nothing here ever sends again. */
  const watching = useRef<Watch | null>(null);

  /**
   * One write, up to the moment the wallet answers.
   *
   * The call is simulated first: a revert costs nothing there and comes back
   * with a name the ABI can decode, where a reverted transaction on chain only
   * ever says "reverted". The simulation and the balance reading are one round
   * trip, because neither depends on the other. The hash the wallet returns is
   * taken only when it is one: Privy's sponsored path answers with an empty
   * string while the transaction is already on its way, and treating that as a
   * failure is how a landed bind gets sent a second time.
   */
  const submit = useCallback(
    async (entry: ConnectedWallet, from: Hex, data: Hex, unsponsored: boolean): Promise<Submitted> => {
      await ensureMonad(entry);

      const [, balanceBefore] = await Promise.all([
        chain.call({ account: from, to: addresses.registry, data }),
        unsponsored ? Promise.resolve(null) : chain.getBalance({ address: from }),
      ]);

      // The digest was built for this wallet, so this is the wallet that sends
      // it. Privy picks the first embedded wallet otherwise, which is not the
      // same thing on an account that holds more than one.
      const answer = await sendTransaction(
        { to: addresses.registry, data, chainId: CHAIN_ID },
        { sponsor: !unsponsored, address: from },
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
   * registry holds the key this device made. Safe to run again: it reads, it
   * never sends.
   */
  const finishBind = useCallback(async () => {
    const watch = watching.current;
    if (watch === null || watch.kind !== "bind") {
      return;
    }

    dispatchBind({ type: "stage", stage: "sending" });
    setConfirming(true);
    try {
      const landed = await confirmBind({
        wallet: watch.wallet,
        qx: watch.qx,
        qy: watch.qy,
        nonceBefore: watch.nonceBefore,
        hash: watch.hash,
      });
      if (landed.hash !== undefined) {
        dispatchBind({ type: "sent", txHash: landed.hash });
      }

      await settleSponsorship(watch.wallet, watch.balanceBefore);
      // Only now: the registry has answered with these exact bytes, so this
      // credential is the one it will check every signature against.
      rememberCredential(watch.wallet, { credentialId: watch.credentialId, qx: watch.qx, qy: watch.qy });
      watching.current = null;
      pending.current = null;
      dispatchBind({ type: "bound" });
      binding.refresh();
    } catch (error) {
      dispatchBind({ type: "failed", failure: describeFailure(error, "confirm", watch.wallet) });
    } finally {
      setConfirming(false);
    }
  }, [binding, settleSponsorship]);

  const sendBind = useCallback(
    async (ready: Extract<Pending, { kind: "bind" }>, unsponsored: boolean) => {
      if (embedded === undefined || wallet === undefined) {
        return;
      }

      dispatchBind({ type: "stage", stage: "sending" });
      let sent: Submitted;
      try {
        sent = await submit(embedded, wallet, ready.data, unsponsored);
      } catch (error) {
        const failure = describeFailure(error, "send", wallet);
        if (failure.next === "unsponsored") {
          setBalance(await chain.getBalance({ address: wallet }).catch(() => null));
        }
        dispatchBind({ type: "failed", failure });
        return;
      }

      if (sent.hash !== undefined) {
        dispatchBind({ type: "sent", txHash: sent.hash });
      }

      watching.current = {
        kind: "bind",
        wallet,
        qx: ready.qx,
        qy: ready.qy,
        nonceBefore: ready.nonceBefore,
        hash: sent.hash,
        balanceBefore: sent.balanceBefore,
        credentialId: ready.credentialId,
      };

      await finishBind();
    },
    [embedded, finishBind, submit, wallet],
  );

  const bindThisDevice = useCallback(async () => {
    if (embedded === undefined || wallet === undefined) {
      return;
    }

    // A bind is already out. Making a second passkey over it would replace the
    // key the first one is about to write, so the card asks Monad instead.
    if (watching.current?.kind === "bind") {
      dispatchBind({ type: "failed", failure: { key: "confirmPending", next: "recheck", address: wallet } });
      return;
    }

    // The last one was refused before it left the wallet. The key is made and
    // the signature is good, so the same bytes go out again rather than a
    // second passkey being made over the first.
    if (isResendable(bind.failure) && pending.current?.kind === "bind") {
      await sendBind(pending.current, false);
      return;
    }

    const rpId = window.location.hostname;
    const origin = window.location.origin;

    dispatchBind({ type: "stage", stage: "creating" });
    let created;
    try {
      created = await createPasskey({
        rpId,
        wallet,
        displayName: accountName(user as SignedInUser | null).value ?? wallet,
      });
      dispatchBind({ type: "created", qx: created.qx, qy: created.qy });
    } catch (error) {
      dispatchBind({ type: "failed", failure: describeFailure(error, "sign", wallet) });
      return;
    }

    let ready: Extract<Pending, { kind: "bind" }>;
    try {
      const nonce = await bindNonce(wallet);
      const digest = localBindDigest(wallet, created.qx, created.qy, nonce);
      assertDigestMatches(digest, await hashBind(wallet, created.qx, created.qy, nonce));

      const signed = await signDigest({ rpId, digest, credentialId: created.credentialId });
      const check = await checkAuth(signed.auth, digest, created.qx, created.qy, { rpId, origin });
      if (!check.ok) {
        throw new AuthCheckFailed(check.problem, check.message);
      }

      ready = {
        kind: "bind",
        data: bindPasskeyCalldata(created.qx, created.qy, signed.auth),
        qx: created.qx,
        qy: created.qy,
        nonceBefore: nonce,
        credentialId: signed.credentialId,
      };
      pending.current = ready;
    } catch (error) {
      dispatchBind({ type: "failed", failure: describeFailure(error, "sign", wallet) });
      return;
    }

    await sendBind(ready, false);
  }, [bind.failure, embedded, sendBind, user, wallet]);

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

    const rpId = window.location.hostname;
    const origin = window.location.origin;
    const onChain = binding.passkey;

    setRecovering(true);
    setRecovery(null);

    try {
      const digest = randomDigest();
      const signed = await signDigest({ rpId, digest });
      const check = await checkAuth(signed.auth, digest, onChain.qx, onChain.qy, { rpId, origin });
      if (!check.ok) {
        throw new AuthCheckFailed(check.problem, check.message);
      }

      const remembered = { credentialId: signed.credentialId, qx: onChain.qx, qy: onChain.qy };
      rememberCredential(wallet, remembered);
      binding.remember(remembered);
    } catch (error) {
      setRecovery(describeFailure(error, "sign"));
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
      const landed = await confirmRegister({
        exactHash: watch.exactHash,
        hash: watch.hash,
        registeredBefore: watch.registeredBefore,
      });
      if (landed.hash !== undefined) {
        dispatchRegister({ type: "sent", txHash: landed.hash });
      }
      dispatchRegister({ type: "confirmed", block: landed.blockNumber ?? null, at: landed.registeredAt ?? Date.now() });

      await settleSponsorship(watch.wallet, watch.balanceBefore);
      watching.current = null;
      pending.current = null;
      passports.refresh();
    } catch (error) {
      dispatchRegister({ type: "failed", failure: describeFailure(error, "confirm", watch.wallet), stage: "confirm" });
    }
  }, [passports, settleSponsorship]);

  const sendRegister = useCallback(
    async (data: Hex, exactHash: Hex, unsponsored: boolean) => {
      if (embedded === undefined || wallet === undefined) {
        return;
      }

      dispatchRegister({ type: "start", step: "send", unsponsored });

      // What the registry held a moment before the send, so a passport written
      // by somebody else is never read as this transaction landing.
      const before = await getPassport(exactHash).catch(() => null);

      try {
        const sent = await submit(embedded, wallet, data, unsponsored);
        watching.current = {
          kind: "register",
          wallet,
          exactHash,
          registeredBefore: before?.registeredAt,
          hash: sent.hash,
          balanceBefore: sent.balanceBefore,
        };
        if (sent.hash !== undefined) {
          dispatchRegister({ type: "sent", txHash: sent.hash });
        }
      } catch (error) {
        const failure = describeFailure(error, "send", wallet);
        if (failure.next === "unsponsored") {
          setBalance(await chain.getBalance({ address: wallet }).catch(() => null));
        }
        dispatchRegister({ type: "failed", failure, stage: "send" });
        return;
      }

      await finishRegister();
    },
    [embedded, finishRegister, submit, wallet],
  );

  const registerImage = useCallback(async () => {
    if (embedded === undefined || wallet === undefined) {
      return;
    }
    if (binding.passkey === null) {
      dispatchRegister({ type: "failed", failure: passkeyNotReady(binding), stage: "prepare" });
      return;
    }
    // The last attempt was refused before anything left the wallet, and the
    // bytes are still signed. They go out as they are, with no second prompt.
    if (isResendable(register.failure) && pending.current?.kind === "register") {
      await sendRegister(pending.current.data, pending.current.exactHash, register.unsponsored);
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
    const origin = window.location.origin;
    const onChain = binding.passkey;

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
      dispatchRegister({ type: "failed", failure: describeFailure(error, "prepare"), stage: "prepare" });
      return;
    }

    dispatchRegister({ type: "start", step: "sign" });
    let data: Hex;
    try {
      const input = passportInputFrom(
        prepared.passport,
        wallet,
        await deadlineFromChain(SIGNATURE_WINDOW_SECONDS),
      );
      // Built here, then checked against the registry's own answer. A
      // disagreement means the two are not describing the same transaction,
      // and it is caught before the passkey is touched rather than after.
      const digest = localPassportDigest(input);
      assertDigestMatches(digest, await hashPassport(input));

      const signed = await signDigest({ rpId, digest, credentialId: binding.credentialId });
      const check = await checkAuth(signed.auth, digest, onChain.qx, onChain.qy, { rpId, origin });
      if (!check.ok) {
        throw new AuthCheckFailed(check.problem, check.message);
      }
      data = registerCalldata(input, signed.auth, "0x");
      pending.current = { kind: "register", data, exactHash: prepared.passport.exactHash };
      dispatchRegister({ type: "signed", digest });
    } catch (error) {
      dispatchRegister({ type: "failed", failure: describeFailure(error, "sign", wallet), stage: "sign" });
      return;
    }

    await sendRegister(data, prepared.passport.exactHash, false);
  }, [binding, embedded, getAccessToken, register.failure, register.file, register.title, register.unsponsored, sendRegister, wallet]);

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
    if (embedded === undefined || wallet === undefined) {
      return;
    }
    if (binding.passkey === null) {
      dispatchRegister({ type: "failed", failure: passkeyNotReady(binding), stage: "prepare" });
      return;
    }
    if (isResendable(register.failure) && pending.current?.kind === "register") {
      await sendRegister(pending.current.data, pending.current.exactHash, register.unsponsored);
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
    const origin = window.location.origin;
    const onChain = binding.passkey;

    dispatchRegister({ type: "start", step: "draw" });
    let drawn;
    let deadline: bigint;
    try {
      const token = await getAccessToken();
      if (token === null) {
        throw new Error("this session has no access token, so the verify service cannot be called");
      }
      deadline = await deadlineFromChain(SIGNATURE_WINDOW_SECONDS);
      drawn = await generate({
        prompt: register.prompt.trim(),
        title: register.title.trim(),
        creator: wallet,
        deadline,
        accessToken: token,
      });
      dispatchRegister({ type: "drawn", response: drawn });
    } catch (error) {
      dispatchRegister({
        type: "failed",
        failure: describeFailure(error, "prepare"),
        quota: error instanceof VerifierError ? error.quota : undefined,
        stage: "prepare",
      });
      return;
    }

    // The agent signed a creator into the struct. If it is not the account on
    // this screen, the registry would refuse the pair, so nobody is asked for
    // their unlock over it.
    if (drawn.passport.creator.toLowerCase() !== wallet.toLowerCase()) {
      dispatchRegister({ type: "failed", failure: { key: "creatorMismatch", next: "signOut" }, stage: "prepare" });
      return;
    }

    dispatchRegister({ type: "start", step: "sign" });
    let data: Hex;
    try {
      const input = passportInputFromGenerated(drawn.passport, deadline);
      const digest = localPassportDigest(input);
      assertDigestMatches(digest, await hashPassport(input));

      const signed = await signDigest({ rpId, digest, credentialId: binding.credentialId });
      const check = await checkAuth(signed.auth, digest, onChain.qx, onChain.qy, { rpId, origin });
      if (!check.ok) {
        throw new AuthCheckFailed(check.problem, check.message);
      }
      data = registerCalldata(input, signed.auth, drawn.generatorSig);
      pending.current = { kind: "register", data, exactHash: drawn.passport.exactHash };
      dispatchRegister({ type: "signed", digest });
    } catch (error) {
      dispatchRegister({ type: "failed", failure: describeFailure(error, "sign", wallet), stage: "sign" });
      return;
    }

    await sendRegister(data, drawn.passport.exactHash, false);
  }, [binding, embedded, getAccessToken, register.failure, register.prompt, register.title, register.unsponsored, sendRegister, wallet]);

  /** The same signed bytes, sent once more. Nothing is rebuilt and no passkey is asked for. */
  const resend = useCallback(
    async (unsponsored: boolean) => {
      const ready = pending.current;
      if (ready === null) {
        return;
      }
      if (ready.kind === "register") {
        await sendRegister(ready.data, ready.exactHash, unsponsored);
        return;
      }
      await sendBind(ready, unsponsored);
    },
    [sendBind, sendRegister],
  );

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
      resend,
      recheck,
      clearBind: () => dispatchBind({ type: "reset" }),
      reset: () => dispatchRegister({ type: "reset" }),
    },
    passports,
  };
}

/**
 * What to say when a register is asked for before the chain has answered about
 * the passkey. Silence here read as a dead button, which is worse than a line
 * asking for another moment.
 */
function passkeyNotReady(binding: Binding): Failure {
  return { key: "unknown", reason: binding.error ?? undefined, next: "again" };
}

function randomDigest(): Hex {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
