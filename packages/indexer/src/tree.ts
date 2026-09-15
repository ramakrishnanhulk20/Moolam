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

/// Every passport below `ancestor` in the same edit tree, given every row that
/// shares the tree's root.
///
/// The caller fetches the tree with one indexed query on root, so this walk costs
/// no further lookups. Only rows deeper than the ancestor are considered, which
/// keeps the walk finite whatever the input, and the parent links inside that set
/// pick out the real descendants rather than every cousin at the same depth.
export function descendantsOf(
  ancestor: Passport,
  family: readonly Passport[],
): Passport[] {
  const childrenByParent = new Map<string, Passport[]>();
  for (const passport of family) {
    if (passport.depth <= ancestor.depth || passport.parent_id === undefined) {
      continue;
    }
    const siblings = childrenByParent.get(passport.parent_id);
    if (siblings === undefined) {
      childrenByParent.set(passport.parent_id, [passport]);
    } else {
      siblings.push(passport);
    }
  }

  const found: Passport[] = [];
  const queue: string[] = [ancestor.id];
  while (queue.length > 0) {
    const parentId = queue.shift() as string;
    for (const child of childrenByParent.get(parentId) ?? []) {
      found.push(child);
      queue.push(child.id);
    }
  }
  return found;
}
