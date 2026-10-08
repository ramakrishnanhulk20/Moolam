"use client";

import { usePrivy, useSigners, useWallets } from "@privy-io/react-auth";
import { useCallback, useMemo, useReducer, useRef, useState } from "react";
import type { Hex } from "viem";
import { awaitPassport } from "@/lib/data/passports";
import { editSigner } from "@/lib/env";
import { VerifierError, edit } from "@/lib/verifier/client";
import { confirmEdit } from "./confirm";
import {
  checkEditImage,
  describeEditFailure,
  describeGrantFailure,
  editReducer,
  initialEditState,
  isEditOutstanding,
  type EditFailure,
  type EditState,
} from "./edit";
import { ownsPassport, signerGranted, type LinkedAccount } from "./owner";

/** Everything the panel on a passport page needs, and nothing the rest of the page reads. */
export interface PassportEdit {
  /** Privy has answered about this session. Until then the panel draws nothing. */
  ready: boolean;
  /** The signed in account holds this passport. Everyone else is shown nothing at all. */
  isOwner: boolean;
  /** Both public ids are set, so a grant can name the signer and its policy. */
  configured: boolean;
  wallet?: Hex;
  /** This wallet has a signer on it. Whether it is this app's, under the policy, only /edit knows. */
  granted: boolean;
  granting: boolean;
  revoking: boolean;
  grantFailure: EditFailure | null;
  state: EditState;
  actions: {
    grant: () => Promise<void>;
    revoke: () => Promise<void>;
    choose: (file: File) => void;
    setTitle: (title: string) => void;
    setNote: (note: string) => void;
    submit: () => Promise<void>;
    /** Asks Monad again about an edit that was sent and has not shown up. Sends nothing. */
    recheck: () => Promise<void>;
    signIn: () => void;
    reset: () => void;
  };
}

/**
 * The edit that is out, and what proves it landed.
 *
 * A child id is the ordinary case: the service names the child it built on every answer that
 * leaves a transaction on the network, so the registry holding that one passport is the fact to
 * wait for. Without one, which is what a lost answer leaves behind, the parent's own edit count is
 * watched instead. Either way this is a read and never a send.
 */
interface Watch {
  childId?: Hex;
  hash?: Hex;
}

/**
 * What the last grant or revoke made true, against the wallet it was made on and what Privy was
 * saying at the time. The override stands until Privy's own answer moves, which is how a stale
 * "granted" from a revoked signer used to survive a wallet switch.
 */
interface JustChanged {
  wallet: string;
  value: boolean;
  /** What signerGranted said at the moment the grant or the revoke went through. */
  live: boolean;
}

/**
 * The failures that happen with the pins already done, so the first step stays green and the send
 * is the one wearing the result.
 */
const AFTER_THE_PINS = new Set(["sendFailed", "sendPending", "confirmPending"]);

/**
 * The owner's side of one passport: grant this app a signer, then add an edited version of the
 * picture without touching a passkey.
 *
 * Nothing is signed here. The transaction goes out from the owner's own Privy wallet, asked for by
 * the service with the app's authorization key, and the policy on that key allows appendEdit on
 * the registry and nothing else. So the worst this app can do with the grant is add an edit.
 *
 * The wait afterwards is by state, not by hash: the registry holding the child passport is the
 * answer, and the parent's own list of edits is read back from it so the page can redraw the tree.
 */
export function useEditPassport({
  parentId,
  owner,
  onLanded,
}: {
  parentId: Hex;
  owner: Hex | null;
  /** Called once the child is on chain, so the page can re-read the lineage the server rendered. */
  onLanded?: () => void;
}): PassportEdit {
  const { ready, authenticated, user, login, getAccessToken } = usePrivy();
  const { wallets } = useWallets();
  const { addSigners, removeSigners } = useSigners();

  const embedded = useMemo(() => wallets.find((entry) => entry.walletClientType === "privy"), [wallets]);
  const wallet = embedded?.address as Hex | undefined;

  const [state, dispatch] = useReducer(editReducer, initialEditState);
  const [granting, setGranting] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [grantFailure, setGrantFailure] = useState<EditFailure | null>(null);
  const [justChanged, setJustChanged] = useState<JustChanged | null>(null);

  /** The edit that is out, so a recheck can look again without sending a second one. */
  const watching = useRef<Watch | null>(null);
  /** True while a wait is running, so a second press of the button joins it rather than doubling it. */
  const polling = useRef(false);

  const accounts = user?.linkedAccounts as readonly LinkedAccount[] | undefined;
  const live = signerGranted(accounts, wallet);
  const held = wallet?.toLowerCase();
  const granted =
    justChanged !== null && justChanged.wallet === held && justChanged.live === live ? justChanged.value : live;

  /** Remembers what a grant or a revoke just made true, against what Privy is saying right now. */
  const remember = useCallback(
    (value: boolean) => {
      if (held !== undefined) {
        setJustChanged({ wallet: held, value, live });
      }
    },
    [held, live],
  );

  const grant = useCallback(async () => {
    if (wallet === undefined || editSigner === null) {
      return;
    }
    setGranting(true);
    setGrantFailure(null);
    try {
      await addSigners({
        address: wallet,
        signers: [{ signerId: editSigner.signerId, policyIds: [editSigner.policyId] }],
      });
      remember(true);
    } catch (error) {
      setGrantFailure(describeGrantFailure(error));
    } finally {
      setGranting(false);
    }
  }, [addSigners, remember, wallet]);

  const revoke = useCallback(async () => {
    if (wallet === undefined) {
      return;
    }
    setRevoking(true);
    setGrantFailure(null);
    try {
      // Privy's browser SDK removes every signer on the wallet: there is no call that takes one
      // signer id, so the panel says what is being given up before this runs.
      await removeSigners({ address: wallet });
      remember(false);
      dispatch({ type: "reset" });
    } catch (error) {
      setGrantFailure(describeGrantFailure(error));
    } finally {
      setRevoking(false);
    }
  }, [remember, removeSigners, wallet]);

  /** Watches Monad for the edit that is out. Safe to run again: it reads, it never sends. */
  const finish = useCallback(async () => {
    const out = watching.current;
    if (out === null || polling.current) {
      return;
    }
    polling.current = true;
    // Said before the wait, not after it, so the panel counts as busy for the whole of it and the
    // submit button cannot offer a second send while Monad is being asked about the first.
    dispatch({ type: "watching" });
    try {
      const landed = await confirmEdit({ parentId, childId: out.childId, hash: out.hash });
      watching.current = null;
      // The edit is a new passport in this wallet's own list, which the index shows a little later.
      if (wallet !== undefined && out.childId !== undefined) {
        awaitPassport(wallet, out.childId);
      }
      dispatch({
        type: "confirmed",
        block: landed.blockNumber ?? null,
        children: landed.children,
        total: landed.total,
      });
      onLanded?.();
    } catch (error) {
      dispatch({ type: "failed", failure: describeEditFailure(error, { sent: true }), stage: "send" });
    } finally {
      polling.current = false;
    }
  }, [onLanded, parentId, wallet]);

  const submit = useCallback(async () => {
    if (wallet === undefined || editSigner === null) {
      return;
    }
    // An edit that may already be on chain is never sent again, whatever the button says.
    if (isEditOutstanding(state)) {
      return;
    }
    if (state.file === null) {
      dispatch({ type: "failed", failure: { key: "fileMissing" }, stage: "pin" });
      return;
    }
    if (state.title.trim().length === 0) {
      dispatch({ type: "failed", failure: { key: "titleMissing" }, stage: "pin" });
      return;
    }
    const refused = checkEditImage(state.file);
    if (refused !== null) {
      dispatch({ type: "failed", failure: refused, stage: "pin" });
      return;
    }

    dispatch({ type: "start" });
    try {
      const token = await getAccessToken();
      if (token === null) {
        throw new Error("this session has no access token, so the verify service cannot be called");
      }
      const result = await edit({
        file: state.file,
        title: state.title.trim(),
        parentId,
        note: state.note.trim(),
        accessToken: token,
      });
      dispatch({ type: "pinned", result });
      watching.current = { childId: result.child.exactHash, hash: result.hash };
    } catch (error) {
      const failure = describeEditFailure(error);
      if (failure.key === "noSigner") {
        // The grant is not on the wallet, or it is there without the policy. Either way the panel
        // goes back to asking for it rather than leaving a button that cannot work.
        remember(false);
      }
      if (failure.key === "sendPending" && error instanceof VerifierError) {
        // Privy took this transaction and the service could not see it land. It may still land, so
        // the panel gets the same watch a success gets and the button offers a second look, never
        // a second send.
        watching.current = { childId: error.passportId, hash: error.hash };
      } else if (failure.key === "confirmPending") {
        // The answer never made it back, so there is no child id. The parent's own count is the
        // fact left to watch.
        watching.current = { hash: error instanceof VerifierError ? error.hash : undefined };
      }
      dispatch({
        type: "failed",
        failure,
        stage: AFTER_THE_PINS.has(failure.key) ? "send" : "pin",
        quota: error instanceof VerifierError ? error.quota : undefined,
      });
      return;
    }

    await finish();
  }, [finish, getAccessToken, parentId, remember, state, wallet]);

  return {
    ready,
    isOwner: authenticated && ownsPassport(owner, wallet),
    configured: editSigner !== null,
    wallet,
    granted,
    granting,
    revoking,
    grantFailure,
    state,
    actions: {
      grant,
      revoke,
      choose: (file: File) => dispatch({ type: "choose", file }),
      setTitle: (title: string) => dispatch({ type: "title", title }),
      setNote: (note: string) => dispatch({ type: "note", note }),
      submit,
      recheck: finish,
      signIn: login,
      reset: () => {
        watching.current = null;
        dispatch({ type: "reset" });
      },
    },
  };
}
