// Attack 6 of the second attack pass: a picture is proven fake, and the creator appends an edit
// of it. On chain the edit reads clean, because the registry marks only the passport a challenge
// named.
// The two ids below are the ones the fork run registered, flagged and edited, printed in
// proofs/attacks/pass-2.txt: the parent came back disputed true and the child disputed false.
// The rows here are those rows, in the shape the index stores them, fed to the pure walk the web
// derives the Disputed chip and the passport page from.
// Does NOT cover the index query itself or the hosted index's own inheritedDisputed column. When
// that column ships the walk is skipped entirely, which lib/data/lineage.ts decides by asking the
// index for its schema.

import { describe, expect, it } from "vitest";
import { LINEAGE_DEPTH, anyDisputed, disputedFamily, reaches, type FamilyRow } from "@/lib/data/lineage";

/** The picture a challenge was upheld against, on the forked registry. */
const PARENT = "0x1f49563bbe143b149dfd33f517308ffa3935d7c814e7946135689648cfdee81c";

/** The edit of it, appended by the owner afterwards. The chain has this one as disputed false. */
const CHILD = "0xffd24f36cd2a621d8398f54122316ee4f3c039f1ce40a4a440fc70b08f658383";

/** The two rows as the index stores them: the chain's own answer, nothing added. */
const ROWS: FamilyRow[] = [
  { id: PARENT, parentId: null, disputed: true },
  { id: CHILD, parentId: PARENT, disputed: false },
];

describe("an edit of a picture that was proven fake", () => {
  it("reads clean on its own row, which is what the chain says", () => {
    expect(anyDisputed({ disputed: false, parent: null })).toBe(false);
  });

  it("reads disputed once the parent link is walked", () => {
    expect(anyDisputed({ disputed: false, parent: { disputed: true, parent: null } })).toBe(true);
  });

  it("is in the set the Disputed chip covers, together with its parent", () => {
    const covered = disputedFamily(ROWS);

    expect(covered).toContain(CHILD);
    expect(covered).toContain(PARENT);
    expect(covered).toHaveLength(2);
  });

  it("is covered whether the index answers with the field or with the walked list", () => {
    expect(reaches({ ids: disputedFamily(ROWS) }, { id: CHILD })).toBe(true);
    expect(reaches("field", { id: CHILD, inheritedDisputed: true })).toBe(true);
    expect(reaches("field", { id: CHILD })).toBe(false);
  });

  it("leaves an edit of a clean picture alone, so the walk is not marking everything", () => {
    const clean: FamilyRow[] = [
      { id: `0x${"11".repeat(32)}`, parentId: null, disputed: false },
      { id: `0x${"22".repeat(32)}`, parentId: `0x${"11".repeat(32)}`, disputed: false },
    ];

    expect(disputedFamily(clean)).toEqual([]);
  });

  it("walks as far above an edit as the depth allows, and says so by stopping", () => {
    const id = (step: number) => `0x${String(step).padStart(2, "0")}`;
    const chain: FamilyRow[] = [{ id: id(0), parentId: null, disputed: true }];
    for (let step = 1; step <= LINEAGE_DEPTH + 1; step += 1) {
      chain.push({ id: id(step), parentId: id(step - 1), disputed: false });
    }

    const covered = disputedFamily(chain);

    expect(covered).toContain(id(LINEAGE_DEPTH));
    expect(covered).not.toContain(id(LINEAGE_DEPTH + 1));
  });
});
