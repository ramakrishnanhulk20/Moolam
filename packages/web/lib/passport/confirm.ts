import type { Hex } from "viem";
import { getChildren } from "@/lib/chain/registry";
import { confirmRegister } from "@/lib/studio/confirm";

/**
 * Confirming an edit by the state it changed, never by the hash alone.
 *
 * The wait itself is the studio's: the child is a passport like any other, so the registry holding
 * it is the fact worth watching, and the hash is raced against that poll rather than depended on.
 * What is added here is the parent's own list, read once the child is on chain, because the number
 * of edits under the parent going up by one is what the reader sees on the page.
 */

const POLL_MS = 1_000;

/** How long the parent's list gets to show the child, after the chain already holds it. */
const CHILD_WINDOW_MS = 20_000;

export interface EditConfirmed {
  hash?: Hex;
  blockNumber?: bigint;
  /** The parent's edits, oldest first, as the registry lists them now. */
  children: Hex[];
}

/**
 * Waits until the registry holds the child passport, then reads the parent's edits back.
 *
 * Throws ConfirmTimeout from the shared wait when Monad has not shown the child inside its window.
 * That is not a failed send: the transaction may still land, so nothing here offers to send again.
 */
export async function confirmEdit({
  parentId,
  childId,
  hash,
}: {
  parentId: Hex;
  childId: Hex;
  hash?: string | null;
}): Promise<EditConfirmed> {
  const landed = await confirmRegister({ exactHash: childId, hash });
  return { hash: landed.hash, blockNumber: landed.blockNumber, children: await childrenHolding(parentId, childId) };
}

/**
 * The parent's edits once the list holds this child.
 *
 * childCount and the child record are written in the same transaction, so this normally answers on
 * the first read. It polls because an RPC node that served the child from one block can still be a
 * block behind on the parent's array, and a lineage drawn without the new edit would look like the
 * edit had not happened.
 */
async function childrenHolding(parentId: Hex, childId: Hex): Promise<Hex[]> {
  const wanted = childId.toLowerCase();
  const deadline = Date.now() + CHILD_WINDOW_MS;

  for (;;) {
    const children = await getChildren(parentId).catch((): Hex[] => []);
    if (children.some((child) => child.toLowerCase() === wanted)) {
      return children;
    }
    if (Date.now() >= deadline) {
      return children;
    }
    await sleep(POLL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
