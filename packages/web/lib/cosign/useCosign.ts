"use client";

import { usePrivy, useSendTransaction, useWallets, type ConnectedWallet } from "@privy-io/react-auth";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { getAddress, type Hex } from "viem";
import { bindPasskeyCalldata, registerCalldata } from "@/lib/chain/calldata";
import { CHAIN_ID, addresses, chain } from "@/lib/chain/client";
import { assertDigestMatches, localBindDigest, localPassportDigest } from "@/lib/chain/digest";
import { bindNonce, getOwner, getPassport, hashBind, hashPassport } from "@/lib/chain/registry";
import { headTimestamp } from "@/lib/chain/time";
import { Reverted } from "@/lib/chain/watch";
import { getConsent } from "@/lib/chain/consent";
import { setConsentRequest } from "@/lib/consent/call";
import { confirmSetConsent } from "@/lib/consent/confirm";
import { describeConsentFailure } from "@/lib/consent/failure";
import { createPasskey, rememberCredential, signDigest } from "@/lib/passkey/browser";
import { checkAuth } from "@/lib/passkey/verify";
import { accountName, type SignedInUser } from "@/lib/studio/account";
import { useWalletState } from "@/lib/studio/binding";
import { confirmBind, confirmRegister, transactionHash } from "@/lib/studio/confirm";
import { accountChanged } from "@/lib/studio/flow";
import { AuthCheckFailed, describeFailure, type Failure } from "@/lib/studio/problems";
import { usePasskeyBinding, type Binding } from "@/lib/studio/usePasskeyBinding";
import { ensureMonad } from "@/lib/studio/wallet";
import { cosignAgentFacts } from "./agent";
import { automatic, canSign, cosignReducer, initialCosign, type CosignModel, type Drawn, type Press } from "./flow";
import { browserPinnedReads, checkDigests, drawPinned, firstLook, passportInputOf, pastDeadline, type ChainReads } from "./gate";
import { readHandle } from "./handle";
import { confirmedConsent, confirmedRegistration } from "./landed";
import type { AgentFacts } from "./listing";
import { currentOpener, postRegistered } from "./opener";
import { openRecord, recordStatus, type CosignRecord, type RecordOutcome } from "./record";

/** How often the page asks whether the agent has signed. Modest on purpose: every ask is a chain read on the service. */
export const POLL_MS = 5_000;

/** How often the chain's clock is read against the deadline while a person reads the page (P12). */
export const CLOCK_MS = 15_000;

const CHAIN_READS: ChainReads = {
  passport: getPassport,
  holder: getOwner,
  now: headTimestamp,
  hashPassport,
};

export interface Cosign {
  model: CosignModel;
  agent: AgentFacts | null;
  wallet: Hex | undefined;
  binding: Binding;
  /** The account's own MON, read only once Privy refused to pay a fee. */
  balance: bigint | null;
  press: (press: Press) => void;
}

/** Bytes a passkey already signed, kept so a refused send can go out again untouched. */
type Signed =
  | { kind: "register"; data: Hex; record: CosignRecord }
  | { kind: "bind"; data: Hex; qx: Hex; qy: Hex; nonce: bigint; credentialId: Uint8Array };

/**
 * The co-sign page's whole run, from a handle in the fragment to a passport
 * in the person's account and the platform's terms on chain.
 *
 * Only reads start on their own. The three writes, a passkey bind, the
 * register and the terms, each follow a press: the bind is its own press and
 * never a side effect of signing in (P11), the register is the passkey press,
 * and the terms follow the register the person pressed for.
 */
export function useCosign(): Cosign {
  const { ready, authenticated, user, login, logout, getAccessToken } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const { sendTransaction } = useSendTransaction();

  const embedded = useMemo(() => wallets.find((entry) => entry.walletClientType === "privy"), [wallets]);
  const wallet = embedded === undefined ? undefined : getAddress(embedded.address);
  const walletState = useWalletState(authenticated, walletsReady, embedded !== undefined);
  const binding = usePasskeyBinding(authenticated ? wallet : undefined);

  const [model, dispatch] = useReducer(cosignReducer, initialCosign);
  const [agent, setAgent] = useState<AgentFacts | null>(null);
  const [agentRead, setAgentRead] = useState<string | null>(null);
  // Kept with the wallet it was read for, so another account never sees it.
  const [balanceFor, setBalanceFor] = useState<{ wallet: Hex; value: bigint | null } | null>(null);
  const balance = balanceFor !== null && balanceFor.wallet === wallet ? balanceFor.value : null;

  /** The capability. Held here and nowhere else: never in state, a log, or a message. */
  const handle = useRef<string | null>(null);
  const latest = useRef(model);
  const heldFor = useRef<Hex | undefined>(undefined);
  const sentHash = useRef<Hex | undefined>(undefined);
  const termsOut = useRef<{ hash: Hex | undefined } | null>(null);
  const posted = useRef(false);
  const pendingSend = useRef<Signed | null>(null);
  /** True once this tab's own register left the wallet, so a recheck knows the terms are its to write. */
  const sentHere = useRef(false);
  const pictureUrl = useRef<string | null>(null);

  // Privy hands back a new getAccessToken on some renders; the reads keep the
  // latest one here so an effect that is waiting on an answer is never torn down
  // and dropped by a function that changed identity and nothing else.
  const accessToken = useRef(getAccessToken);

  useEffect(() => {
    latest.current = model;
    accessToken.current = getAccessToken;
  });

  useEffect(() => {
    const read = readHandle();
    handle.current = read;
    dispatch({ type: "handle", valid: read !== null });
  }, []);

  useEffect(() => {
    if (!ready) return;
    if (!authenticated) {
      dispatch({ type: "auth", signedIn: false });
      return;
    }
    if (wallet !== undefined) {
      dispatch({ type: "auth", signedIn: true });
    } else if (walletState === "missing") {
      dispatch({ type: "answer", outcome: { kind: "unavailable" } });
    }
  }, [ready, authenticated, wallet, walletState]);

  useEffect(() => {
    if (wallet === undefined) return;
    if (accountChanged(heldFor.current, wallet)) {
      sentHash.current = undefined;
      termsOut.current = null;
      posted.current = false;
      pendingSend.current = null;
      sentHere.current = false;
      dispatch({ type: "account" });
    }
    heldFor.current = wallet;
  }, [wallet]);

  useEffect(() => {
    dispatch({ type: "binding", status: binding.status });
  }, [binding.status]);

  useEffect(
    () => () => {
      if (pictureUrl.current !== null) URL.revokeObjectURL(pictureUrl.current);
    },
    [],
  );

  const ask = useCallback(async (route: "record" | "status"): Promise<RecordOutcome> => {
    const capability = handle.current;
    const bearer = await accessToken.current().catch(() => null);
    if (capability === null) return { kind: "notFound" };
    if (bearer === null) return { kind: "signIn" };
    return route === "record" ? await openRecord(capability, bearer) : await recordStatus(capability, bearer);
  }, []);

  const auto = automatic(model);

  /**
   * Whether an answer that arrives now still belongs on screen. The effects that
   * start a read also move the state on at once, which ends the effect, so an
   * answer is judged by the account it was asked for rather than by the effect
   * that asked.
   */
  const stillFor = useCallback(
    (asked: Hex | undefined) => asked !== undefined && heldFor.current === asked && latest.current.auth === "in",
    [],
  );

  useEffect(() => {
    if (!auto.open) return;
    const asked = wallet;
    dispatch({ type: "opening" });
    void ask("record").then((outcome) => {
      if (stillFor(asked)) dispatch({ type: "answer", outcome });
    });
  }, [auto.open, ask, stillFor, wallet]);

  const agentId = model.named?.agentId ?? null;
  useEffect(() => {
    if (agentId === null || agentRead === agentId) return;
    let live = true;
    void cosignAgentFacts(agentId)
      .catch(() => null)
      .then((facts) => {
        if (!live) return;
        setAgent(facts);
        setAgentRead(agentId);
      });
    return () => {
      live = false;
    };
  }, [agentId, agentRead]);

  // While the agent has still to sign: the status route, and the chain's clock
  // against the deadline, until one of them moves the page on (P12).
  useEffect(() => {
    if (!auto.poll) return;
    let live = true;
    const tick = async () => {
      const outcome = await ask("status");
      if (!live) return;
      if (outcome.kind === "record" && outcome.record.state === "signed") {
        // The status answer names no digest to a person, so the record route is asked for it.
        const full = await ask("record");
        if (live) dispatch({ type: "answer", outcome: full });
        return;
      }
      dispatch({ type: "answer", outcome });
      const record = latest.current.record;
      if (record !== null) {
        const now = await headTimestamp().catch(() => null);
        if (live && now !== null && pastDeadline(record, now)) dispatch({ type: "expired" });
      }
    };
    const timer = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [auto.poll, ask]);

  useEffect(() => {
    if (!auto.clock) return;
    let live = true;
    const timer = window.setInterval(() => {
      const record = latest.current.record;
      if (record === null) return;
      void headTimestamp()
        .then((now) => {
          if (live && pastDeadline(record, now)) dispatch({ type: "expired" });
        })
        .catch(() => undefined);
    }, CLOCK_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [auto.clock]);

  const draw = useCallback(async (record: CosignRecord): Promise<Drawn | null> => {
    const pinned = await drawPinned(record, browserPinnedReads);
    if (!pinned.ok) {
      dispatch({ type: "gate", gate: { at: "failed", what: pinned.what } });
      return null;
    }
    if (pictureUrl.current !== null) URL.revokeObjectURL(pictureUrl.current);
    const url = URL.createObjectURL(new Blob([pinned.picture as BlobPart], { type: "image/jpeg" }));
    pictureUrl.current = url;
    const drawn: Drawn = { picture: url, title: pinned.title, terms: pinned.terms };
    dispatch({ type: "drawn", drawn });
    return drawn;
  }, []);

  // P6, P12 and P1, in that order, once the record is signed and pinned.
  useEffect(() => {
    const record = latest.current.record;
    if (!auto.gate || record === null || wallet === undefined) return;
    const asked = wallet;
    const live = () => stillFor(asked);
    dispatch({ type: "gate", gate: { at: "checking" } });
    void (async () => {
      try {
        const look = await firstLook(record, wallet, CHAIN_READS);
        if (!live()) return;
        if (look.kind === "ours") {
          dispatch({ type: "answer", outcome: { kind: "record", record: { ...record, state: "registered" } } });
          return;
        }
        if (look.kind === "taken") {
          dispatch({ type: "taken", holder: look.holder });
          return;
        }
        if (look.kind === "expired") {
          dispatch({ type: "expired" });
          return;
        }
        if ((await draw(record)) === null || !live()) return;
        const gate = await checkDigests(record, wallet, CHAIN_READS);
        if (live()) dispatch({ type: "gate", gate });
      } catch {
        // A read that failed says nothing about the record, so it is a wait, never a mismatch.
        if (live()) dispatch({ type: "answer", outcome: { kind: "unavailable" } });
      }
    })();
  }, [auto.gate, wallet, draw, stillFor]);

  /**
   * Says registered only once the receipt behind the passport is found (P13).
   * On a page opened again after the passport landed (`ownSend` false), the
   * consent register is read too: terms already there are named with their
   * writer and left alone, and when there are none and the file carries some,
   * the page offers to write them on a press (P9, P24).
   */
  const confirmLanded = useCallback(
    async (record: CosignRecord, hash: Hex | undefined, ownSend: boolean) => {
      const passportId = record.passport.exactHash;
      const txHash = await confirmedRegistration(passportId, hash).catch(() => null);
      if (txHash === null) {
        dispatch({ type: "send", send: { at: "unconfirmed", failure: null } });
        return;
      }
      const drawn = latest.current.drawn ?? (await draw(record).catch(() => null));
      dispatch({ type: "send", send: { at: "registered", passportId, txHash } });
      if (ownSend) return;
      const reading = await getConsent(passportId).catch(() => null);
      if (reading === null) return;
      if (reading.entry !== null) {
        dispatch({ type: "terms", terms: { at: "stated", writer: reading.entry.writer } });
      } else if (drawn?.terms !== null && drawn?.terms !== undefined) {
        dispatch({ type: "terms", terms: { at: "offered" } });
      }
    },
    [draw],
  );

  // A passport the chain already holds for this person, found on a page opened
  // again after the send: said to be registered only once its receipt is found.
  useEffect(() => {
    const record = latest.current.record;
    if (!auto.landed || record === null) return;
    void confirmLanded(record, undefined, false);
  }, [auto.landed, confirmLanded]);

  /**
   * One write from the person's embedded wallet. The fee is Moolam's unless
   * the person chose to pay it after Privy refused, which is the studio's own
   * way out of a refusal and never the first try.
   */
  const send = useCallback(
    async (entry: ConnectedWallet, from: Hex, to: Hex, data: Hex, unsponsored = false): Promise<Hex | undefined> => {
      await ensureMonad(entry);
      // A revert costs nothing here and comes back named, where a mined revert only says "reverted".
      await chain.call({ account: from, to, data });
      const answer = await sendTransaction({ to, data, chainId: CHAIN_ID }, { sponsor: !unsponsored, address: from });
      return transactionHash(answer.hash);
    },
    [sendTransaction],
  );

  /** A refused send, with the account's own MON read when Privy would not pay, as the studio does. */
  const refused = useCallback(
    async (error: unknown): Promise<Failure> => {
      const failure = describeFailure(error, "send", wallet);
      if (failure.next === "unsponsored" && wallet !== undefined) {
        setBalanceFor({ wallet, value: await chain.getBalance({ address: wallet }).catch(() => null) });
      }
      return failure;
    },
    [wallet],
  );

  const writeTerms = useCallback(async () => {
    const current = latest.current;
    const terms = current.drawn?.terms ?? null;
    if (embedded === undefined || wallet === undefined || terms === null || current.send.at !== "registered") return;
    if (current.terms.at === "stated" || current.terms.at === "sending" || current.terms.at === "written") return;
    const passportId = current.send.passportId;
    dispatch({ type: "terms", terms: { at: "sending" } });
    try {
      // A statement already taken by the wallet is only ever asked about again, never sent twice.
      if (termsOut.current === null) {
        const request = setConsentRequest(passportId, terms);
        const hash = await send(embedded, wallet, request.to, request.data);
        termsOut.current = { hash };
      }
      const out = termsOut.current;
      await confirmSetConsent({ passportId, wallet, sent: terms, since: 0, hash: out.hash });
      const txHash = await confirmedConsent(passportId, wallet, out.hash);
      if (txHash === null) {
        dispatch({ type: "terms", terms: { at: "failed", failure: { key: "confirmPending", next: "recheck" } } });
        return;
      }
      dispatch({ type: "terms", terms: { at: "written", txHash } });
    } catch (error) {
      const failure = describeConsentFailure(error);
      if (failure.key !== "confirmPending") termsOut.current = null;
      dispatch({ type: "terms", terms: { at: "failed", failure } });
    }
  }, [embedded, send, wallet]);

  useEffect(() => {
    if (auto.terms) void writeTerms();
  }, [auto.terms, writeTerms]);

  // P10: once, public facts only, to each origin the listing names.
  const agentSettled = agentId !== null && agentRead === agentId;
  useEffect(() => {
    const landed = model.send;
    if (landed.at !== "registered" || !agentSettled || posted.current) return;
    posted.current = true;
    postRegistered(currentOpener(), agent?.listing?.origins ?? [], {
      passportId: landed.passportId,
      txHash: landed.txHash,
    });
  }, [model.send, agentSettled, agent]);

  /** The signed register going out, the first time or again with the person paying the fee. */
  const sendRegister = useCallback(
    async (signed: Extract<Signed, { kind: "register" }>, unsponsored: boolean) => {
      if (embedded === undefined || wallet === undefined) return;
      const record = signed.record;
      dispatch({ type: "send", send: { at: "sending" } });
      let hash: Hex | undefined;
      try {
        hash = await send(embedded, wallet, addresses.registry, signed.data, unsponsored);
      } catch (error) {
        return dispatch({ type: "send", send: { at: "idle", failure: await refused(error) } });
      }

      pendingSend.current = null;
      sentHere.current = true;
      sentHash.current = hash;
      dispatch({ type: "send", send: { at: "confirming" } });
      try {
        await confirmRegister({ exactHash: record.passport.exactHash, hash });
      } catch (error) {
        const failure = describeFailure(error, "confirm", wallet);
        const next = error instanceof Reverted ? { at: "idle" as const, failure } : { at: "unconfirmed" as const, failure };
        return dispatch({ type: "send", send: next });
      }
      if (latest.current.drawn?.terms !== null && latest.current.drawn?.terms !== undefined) {
        dispatch({ type: "terms", terms: { at: "waiting" } });
      }
      await confirmLanded(record, hash, true);
    },
    [confirmLanded, embedded, refused, send, wallet],
  );

  /** The two checks made again before anything goes out: the chain's clock (P12) and whether the bytes were taken meanwhile (P6). */
  const stillClear = useCallback(
    async (record: CosignRecord): Promise<boolean> => {
      if (wallet === undefined) return false;
      try {
        const look = await firstLook(record, wallet, CHAIN_READS);
        if (look.kind === "clear") return true;
        if (look.kind === "taken") dispatch({ type: "taken", holder: look.holder });
        if (look.kind === "expired") dispatch({ type: "expired" });
        if (look.kind === "ours") void confirmLanded(record, undefined, false);
      } catch {
        dispatch({ type: "answer", outcome: { kind: "unavailable" } });
      }
      return false;
    },
    [confirmLanded, wallet],
  );

  const signNow = useCallback(async () => {
    const current = latest.current;
    const record = current.record;
    const passkey = binding.passkey;
    if (!canSign(current) || current.gate.at !== "passed" || record === null || passkey === null) return;
    if (embedded === undefined || wallet === undefined || record.agentSignature === undefined) return;
    if (!(await stillClear(record))) return;

    const rpId = window.location.hostname;
    const origin = window.location.origin;
    const input = passportInputOf(record, wallet);
    dispatch({ type: "send", send: { at: "signing" } });
    let data: Hex;
    try {
      assertDigestMatches(localPassportDigest(input), current.gate.digest);
      const signed = await signDigest({ rpId, digest: current.gate.digest, credentialId: binding.credentialId });
      const check = await checkAuth(signed.auth, current.gate.digest, passkey.qx, passkey.qy, { rpId, origin });
      if (!check.ok) throw new AuthCheckFailed(check.problem, check.message);
      data = registerCalldata(input, signed.auth, record.agentSignature);
    } catch (error) {
      return dispatch({ type: "send", send: { at: "idle", failure: describeFailure(error, "sign", wallet) } });
    }

    // Kept so a refused send goes out again as the same signed bytes, with no second prompt.
    const signedRegister = { kind: "register" as const, data, record };
    pendingSend.current = signedRegister;
    await sendRegister(signedRegister, false);
  }, [binding.credentialId, binding.passkey, embedded, sendRegister, stillClear, wallet]);

  /** The signed bind going out, the first time or again with the person paying the fee. */
  const sendBind = useCallback(
    async (signed: Extract<Signed, { kind: "bind" }>, unsponsored: boolean) => {
      if (embedded === undefined || wallet === undefined) return;
      dispatch({ type: "bind", bind: { at: "sending" } });
      let hash: Hex | undefined;
      try {
        hash = await send(embedded, wallet, addresses.registry, signed.data, unsponsored);
      } catch (error) {
        return dispatch({ type: "bind", bind: { at: "idle", failure: await refused(error) } });
      }
      pendingSend.current = null;
      try {
        await confirmBind({ wallet, qx: signed.qx, qy: signed.qy, nonceBefore: signed.nonce, hash });
      } catch (error) {
        return dispatch({ type: "bind", bind: { at: "idle", failure: describeFailure(error, "confirm", wallet) } });
      }
      // Only now: the registry holds these exact bytes, so this is the key it will check.
      rememberCredential(wallet, { credentialId: signed.credentialId, qx: signed.qx, qy: signed.qy });
      dispatch({ type: "bind", bind: { at: "idle", failure: null } });
      binding.refresh();
    },
    [binding, embedded, refused, send, wallet],
  );

  const bindThisDevice = useCallback(async () => {
    if (embedded === undefined || wallet === undefined || latest.current.bind.at !== "idle") return;
    const rpId = window.location.hostname;
    const origin = window.location.origin;
    dispatch({ type: "bind", bind: { at: "creating" } });
    let signedBind: Extract<Signed, { kind: "bind" }>;
    try {
      const created = await createPasskey({
        rpId,
        wallet,
        displayName: accountName(user as SignedInUser | null).value ?? wallet,
      });
      dispatch({ type: "bind", bind: { at: "waiting" } });
      const nonce = await bindNonce(wallet);
      const digest = localBindDigest(wallet, created.qx, created.qy, nonce);
      assertDigestMatches(digest, await hashBind(wallet, created.qx, created.qy, nonce));
      const signed = await signDigest({ rpId, digest, credentialId: created.credentialId });
      const check = await checkAuth(signed.auth, digest, created.qx, created.qy, { rpId, origin });
      if (!check.ok) throw new AuthCheckFailed(check.problem, check.message);
      signedBind = {
        kind: "bind",
        data: bindPasskeyCalldata(created.qx, created.qy, signed.auth),
        qx: created.qx,
        qy: created.qy,
        nonce,
        credentialId: signed.credentialId,
      };
    } catch (error) {
      return dispatch({ type: "bind", bind: { at: "idle", failure: describeFailure(error, "sign", wallet) } });
    }
    pendingSend.current = signedBind;
    await sendBind(signedBind, false);
  }, [embedded, sendBind, user, wallet]);

  /**
   * The studio's answer to a refused sponsorship: the same signed bytes, sent
   * once more with the person paying the fee. No second passkey prompt, and for
   * a register the chain's clock and the id are checked again first.
   */
  const payOwnFee = useCallback(async () => {
    const signed = pendingSend.current;
    if (signed === null) return;
    if (signed.kind === "bind") {
      await sendBind(signed, true);
      return;
    }
    if (!(await stillClear(signed.record))) return;
    await sendRegister(signed, true);
  }, [sendBind, sendRegister, stillClear]);

  const recoverThisDevice = useCallback(async () => {
    const onChain = binding.passkey;
    if (wallet === undefined || onChain === null || latest.current.bind.at !== "idle") return;
    const rpId = window.location.hostname;
    const origin = window.location.origin;
    dispatch({ type: "bind", bind: { at: "recovering" } });
    try {
      const digest = randomDigest();
      const signed = await signDigest({ rpId, digest });
      const check = await checkAuth(signed.auth, digest, onChain.qx, onChain.qy, { rpId, origin });
      if (!check.ok) throw new AuthCheckFailed(check.problem, check.message);
      const remembered = { credentialId: signed.credentialId, qx: onChain.qx, qy: onChain.qy };
      rememberCredential(wallet, remembered);
      binding.remember(remembered);
      dispatch({ type: "bind", bind: { at: "idle", failure: null } });
    } catch (error) {
      dispatch({ type: "bind", bind: { at: "idle", failure: describeFailure(error, "sign") } });
    }
  }, [binding, wallet]);

  const press = useCallback(
    (which: Press) => {
      switch (which) {
        case "signIn":
          login();
          return;
        case "signOut":
          void logout();
          return;
        case "bind":
          void bindThisDevice();
          return;
        case "recover":
          void recoverThisDevice();
          return;
        case "sign":
          void signNow();
          return;
        case "retry":
          binding.refresh();
          dispatch({ type: "retry" });
          return;
        case "recheck": {
          const record = latest.current.record;
          if (record !== null) void confirmLanded(record, sentHash.current, sentHere.current);
          return;
        }
        case "writeTerms":
          void writeTerms();
          return;
        case "unsponsored":
          void payOwnFee();
          return;
        case "openPassport":
          return;
      }
    },
    [binding, bindThisDevice, confirmLanded, login, logout, payOwnFee, recoverThisDevice, signNow, writeTerms],
  );

  return { model, agent, wallet, binding, balance, press };
}

function randomDigest(): Hex {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
