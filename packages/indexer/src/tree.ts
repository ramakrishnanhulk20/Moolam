import type { Passport } from "envio";

export type TreePosition = {
  /// The original passport at the top of this edit chain.
  rootId: string;
  /// 0 for an original, parent depth plus one for every edit after it.
  depth: number;
};

/// Works out where a newly registered passport sits in its edit tree.
///
/// Root and depth are carried forward from the parent rather than walked up the
/// chain on every read, so a chain of any length costs one lookup. The registry
/// will not accept an edit whose parent is unregistered, so a missing parent here
/// only ever means the indexer's start_block is later than the parent's block.
/// In that case the passport becomes its own root, which keeps the tree readable
/// instead of leaving a dangling reference.
export function treePosition(ownId: string, parent: Passport | undefined): TreePosition {
  if (parent === undefined) {
    return { rootId: ownId, depth: 0 };
  }
  return { rootId: parent.root_id, depth: parent.depth + 1 };
}
