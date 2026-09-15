import type { Hex } from "viem";
import { chain } from "@/lib/chain/client";
import { CHILD_PAGE_SIZE, getChildren, getPassport } from "@/lib/chain/registry";
import { ConfirmTimeout } from "@/lib/studio/confirm";
import { watchState } from "@/lib/chain/watch";

/**
 * Confirming an edit by the state it changed, never by the hash alone.
 *
 * The wait is the shared one in lib/chain/watch: a read that throws mid-window does not end the
 * window, a real hash is raced against the poll rather than depended on, and a receipt that comes
 * back reverted is named as such. What is added here is the parent's own list, read once the child
 * is on chain, because the number of edits under the parent is what the reader sees on the page.
 *
 * With no child id there is still an edit to wait for: a transport failure can eat the answer
 * while the transaction goes out. Then the fact watched is the parent's own count going up from
 * what the first read of this wait showed.
 */

const POLL_MS = 1_000;

/** How long Monad gets to show the edit before the panel says so out loud. */
const CHAIN_WINDOW_MS = 90_000;

/** How long the parent's list gets to show the child, after the chain already holds it. */
const CHILD_WINDOW_MS = 20_000;

const PAGE = { newestFirst: true, size: CHILD_PAGE_SIZE };

export interface EditConfirmed {
  hash?: Hex;
  blockNumber?: bigint;
  /** The parent's newest edits as the registry lists them now, newest first. */
  children: Hex[];
  /** How many edits the parent has in all. */
  total: number;
}

export interface EditConfirmation {
  parentId: Hex;
  /** The child the service named. Absent when the answer never made it back. */
  childId?: Hex;
  hash?: string | null;
  signal?: AbortSignal;
}

/**
 * Waits until Monad shows the edit, then reads the parent's lineage back.
 *
 * Throws ConfirmTimeout when the chain has not shown it inside the window, and when the lineage
 * read never once succeeded after it did. Neither is a failed send: the transaction may be on
 * chain either way, so nothing here offers to send again.
 */
export async function confirmEdit({ parentId, childId, hash, signal }: EditConfirmation): Promise<EditConfirmed> {
  const known = transactionHash(hash);
  const landed =
    childId === undefined
      ? await watchLineage(parentId, known, signal)
      : await watchChild(childId, known, signal);

  const lineage = childId === undefined ? landed.lineage : await childrenHolding(parentId, childId);
  return { hash: landed.hash, blockNumber: await blockOf(landed.hash), children: lineage.items, total: lineage.total };
}

interface Landed {
  hash?: Hex;
  lineage: Lineage;
}

interface Lineage {
  items: Hex[];
  total: number;
}

/** The ordinary wait: the registry holding the child passport is the edit landing. */
async function watchChild(childId: Hex, hash: Hex | undefined, signal?: AbortSignal): Promise<Landed> {
  const watched = await watchState({
    read: () => getPassport(childId),
    done: (record) => record !== null,
    hash,
    windowMs: CHAIN_WINDOW_MS,
    pollMs: POLL_MS,
    signal,
  });

  return { hash: watched.hash, lineage: { items: [], total: 0 } };
}

/**
 * The wait with no child id.
 *
 * The first read of the parent's list is the baseline, and one more edit than that is this edit
 * landing. An edit that was already on chain before the first read looks like nothing happening,
 * which is why the end of this window is a ConfirmTimeout and never a failure: the page says the
 * edit may be out, and the lineage above the panel shows the truth.
 */
async function watchLineage(parentId: Hex, hash: Hex | undefined, signal?: AbortSignal): Promise<Landed> {
  let base: number | null = null;

  const watched = await watchState({
    read: async () => await getChildren(parentId, PAGE),
    done: (page) => {
      if (base === null) {
        base = page.total;
        return false;
      }
      return page.total > base;
    },
    hash,
    windowMs: CHAIN_WINDOW_MS,
    pollMs: POLL_MS,
    signal,
  });

  return { hash: watched.hash, lineage: { items: watched.state.items, total: watched.state.total } };
}

/**
 * The parent's edits once the list holds this child.
 *
 * childCount and the child record are written in the same transaction, so this normally answers on
 * the first read. It polls because an RPC node that served the child from one block can still be a
 * block behind on the parent's array, and a lineage drawn without the new edit would look like the
 * edit had not happened.
 *
 * A read that keeps failing is not an empty lineage. Reporting one used to draw a tree with no
 * edits in it and call the send done, so a window with no successful read at all ends in a
 * ConfirmTimeout instead.
 */
async function childrenHolding(parentId: Hex, childId: Hex): Promise<Lineage> {
  const wanted = childId.toLowerCase();
  const deadline = Date.now() + CHILD_WINDOW_MS;
  let last: Lineage | null = null;

  for (;;) {
    try {
      const page = await getChildren(parentId, PAGE);
      if (page.items.some((child) => child.toLowerCase() === wanted)) {
        return page;
      }
      last = page;
    } catch (error) {
      console.warn("a lineage read while confirming an edit failed, the wait continues:", error);
    }

    if (Date.now() >= deadline) {
      if (last === null) {
        throw new ConfirmTimeout();
      }
      // The chain holds the child and this page does not show it yet, which happens when the
      // parent has more edits than one page holds. The count is from a read that succeeded.
      return last;
    }
    await sleep(POLL_MS);
  }
}

/** The block the transaction landed in, when there is a hash and the node answers for it. */
async function blockOf(hash?: Hex): Promise<bigint | undefined> {
  if (hash === undefined) {
    return undefined;
  }
  const receipt = await chain.getTransactionReceipt({ hash }).catch(() => null);
  return receipt?.blockNumber;
}

const HASH_SHAPE = /^0x[0-9a-fA-F]{64}$/;

/** The hash the service handed back, when it is one. An empty string is absent, not wrong. */
function transactionHash(value: string | null | undefined): Hex | undefined {
  return typeof value === "string" && HASH_SHAPE.test(value) ? (value as Hex) : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
