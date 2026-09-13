"use client";

import { usePrivy, useSigners, useWallets } from "@privy-io/react-auth";
import { useCallback, useMemo, useReducer, useRef, useState } from "react";
import type { Hex } from "viem";
import { chain } from "@/lib/chain/client";
import { getChildren } from "@/lib/chain/registry";
import { editSigner } from "@/lib/env";
import { ConfirmTimeout } from "@/lib/studio/confirm";
import { VerifierError, edit } from "@/lib/verifier/client";
import { confirmEdit, type EditConfirmed } from "./confirm";
import {
  checkEditImage,
  describeEditFailure,
  describeGrantFailure,
  editReducer,
  initialEditState,
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
 * An edit that is out on the network, in the two shapes it can be out in.
 *
 * A `child` watch is the ordinary one: the service answered, so the child's id is known and the
 * registry holding it is the fact to wait for. A `pending` watch is what a 502 `send-pending`
 * leaves behind: Privy took the transaction, the service could not confirm it, and the browser has
 * a transaction id, sometimes a hash, and the parent's edits as they stood before the send.
 */
type Watch =
  | { kind: "child"; childId: Hex; hash?: Hex }
  | { kind: "pending"; hash?: Hex; transactionId?: string; before: Hex[] | null };

/** How long a send with no confirmation gets to show up before the panel says so out loud. */
const PENDING_WINDOW_MS = 90_000;
const PENDING_POLL_MS = 2_000;

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
  /** What the last grant or revoke made true, which Privy's user object may not carry yet. */
  const [justChanged, setJustChanged] = useState<boolean | null>(null);

  /** The edit that is out, so a recheck can look again without sending a second one. */
  const watching = useRef<Watch | null>(null);

  const accounts = user?.linkedAccounts as readonly LinkedAccount[] | undefined;
  const granted = justChanged ?? signerGranted(accounts, wallet);

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
      setJustChanged(true);
    } catch (error) {
      setGrantFailure(describeGrantFailure(error));
    } finally {
      setGranting(false);
    }
  }, [addSigners, wallet]);

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
      setJustChanged(false);
      dispatch({ type: "reset" });
    } catch (error) {
      setGrantFailure(describeGrantFailure(error));
    } finally {
      setRevoking(false);
    }
  }, [removeSigners, wallet]);

  /** Watches Monad for the child that is out. Safe to run again: it reads, it never sends. */
  const finish = useCallback(async () => {
    const out = watching.current;
    if (out === null) {
      return;
    }
    try {
      const landed =
        out.kind === "child"
          ? await confirmEdit({ parentId, childId: out.childId, hash: out.hash })
          : await confirmPendingEdit(parentId, out.before, out.hash);
      dispatch({ type: "confirmed", block: landed.blockNumber ?? null, children: landed.children });
      watching.current = null;
      onLanded?.();
    } catch (error) {
      dispatch({ type: "failed", failure: describeEditFailure(error), stage: "send" });
    }
  }, [onLanded, parentId]);

  const submit = useCallback(async () => {
    if (wallet === undefined || editSigner === null) {
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
    // Read before the send, because it is the answer to "which of these edits is mine" if the
    // service comes back saying the transaction is out and it cannot tell us what it built.
    const before = await getChildren(parentId).catch((): Hex[] | null => null);
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
      watching.current = { kind: "child", childId: result.child.exactHash, hash: result.hash };
    } catch (error) {
      const failure = describeEditFailure(error);
      if (failure.key === "noSigner") {
        // The grant is not on the wallet, or it is there without the policy. Either way the panel
        // goes back to asking for it rather than leaving a button that cannot work.
        setJustChanged(false);
      }
      if (failure.key === "sendPending" && error instanceof VerifierError) {
        // Privy took this transaction and the service could not see it land. It may still land, so
        // the panel gets the same watch a success gets and the button offers a second look, never
        // a second send.
        watching.current = {
          kind: "pending",
          hash: error.hash,
          transactionId: error.transactionId,
          before,
        };
      }
      dispatch({
        type: "failed",
        failure,
        stage: failure.key === "sendFailed" || failure.key === "sendPending" ? "send" : "pin",
        quota: error instanceof VerifierError ? error.quota : undefined,
      });
      return;
    }

    await finish();
  }, [finish, getAccessToken, parentId, state.file, state.note, state.title, wallet]);

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
      reset: () => dispatch({ type: "reset" }),
    },
  };
}

/**
 * A send Privy accepted and the service could not confirm, watched from the browser.
 *
 * There is no child id to look up: the service builds the child and this answer came back before
 * it could say what it built. So two facts are watched instead. A transaction hash, when Privy
 * reported one, is the sharper of the two. The other is the parent's own list of edits: an entry
 * that was not in it before the send is this edit landing.
 *
 * Throws ConfirmTimeout when neither has shown inside the window, which is not a failed send. It
 * reads and it never sends.
 */
async function confirmPendingEdit(parentId: Hex, before: Hex[] | null, hash?: Hex): Promise<EditConfirmed> {
  // Neither fact is in hand, which only happens when the chain would not answer before the send
  // either. Sitting on a poll that can decide nothing would be a fake wait, so it says so at once.
  if (hash === undefined && before === null) {
    throw new ConfirmTimeout();
  }

  const known = new Set((before ?? []).map((id) => id.toLowerCase()));
  const deadline = Date.now() + PENDING_WINDOW_MS;

  for (;;) {
    if (hash !== undefined) {
      const receipt = await chain.getTransactionReceipt({ hash }).catch(() => null);
      if (receipt !== null && receipt.status === "reverted") {
        throw new Error(`Monad mined this edit and it reverted: ${hash}`);
      }
      if (receipt !== null) {
        const children = await getChildren(parentId).catch((): Hex[] => []);
        return { hash, blockNumber: receipt.blockNumber, children };
      }
    }

    if (before !== null) {
      const children = await getChildren(parentId).catch((): Hex[] => []);
      if (children.some((child) => !known.has(child.toLowerCase()))) {
        return { hash, children };
      }
    }

    if (Date.now() >= deadline) {
      throw new ConfirmTimeout(undefined, hash);
    }
    await sleep(PENDING_POLL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
