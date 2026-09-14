import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { carriesManifest, chooseFocal, focalFrom, type IndexRow } from "@/components/story/data";

/**
 * The story tells one passport's story. These fix the rule that decides which
 * one, because the alternative is what the judge audit found: captions naming
 * an agent, a manifest and a re-check over a record whose own page denies all
 * three.
 */

const ZERO = `0x${"0".repeat(64)}` as Hex;
const MANIFEST = `0x${"a7".repeat(32)}` as Hex;

function row(over: Partial<IndexRow> & { id: string; registeredAt: string }): IndexRow {
  return {
    id: over.id as Hex,
    metadataURI: `ipfs://metadata-${over.id}`,
    registeredAt: over.registeredAt,
    registeredBlock: over.registeredBlock ?? "103057874",
    generatorId: over.generatorId === undefined ? "10248" : over.generatorId,
    creator: (over.creator ?? "0x559f357ada3a96d11aea679ec0d622e4af15f67c") as Hex,
    kind: over.kind ?? 0,
    manifestHash: over.manifestHash ?? MANIFEST,
    attestations: over.attestations ?? 0,
  };
}

/** The shape of the live index on 2026-09-13: one record carries the whole story. */
const INDEX: IndexRow[] = [
  row({ id: "0x75bf8bf1", registeredAt: "1789038720", kind: 1, generatorId: null, manifestHash: ZERO }),
  row({ id: "0xcf7bc9c0", registeredAt: "1788945439", kind: 1, generatorId: null }),
  row({ id: "0x1d9dfdba", registeredAt: "1788945439" }),
  row({ id: "0x533e4edd", registeredAt: "1788938100", kind: 2, generatorId: "10249" }),
  row({ id: "0x5f66c389", registeredAt: "1788876082", attestations: 1 }),
  row({ id: "0xb328bab5", registeredAt: "1788875220" }),
  row({ id: "0xb95adc0c", registeredAt: "1788875160", kind: 1, generatorId: null, manifestHash: ZERO }),
];

const ALL_PICTURED = INDEX.map(() => true);

describe("the passport the story follows", () => {
  it("takes the newest record that has the agent, the manifest and a re-check", () => {
    const chosen = chooseFocal(INDEX, ALL_PICTURED);

    expect(chosen).not.toBeNull();
    expect(chosen?.reason).toBe("full");

    const picked = INDEX[(chosen as { index: number }).index];
    expect(picked.id).toBe("0x5f66c389");
    expect(picked.kind).toBe(0);
    expect(picked.generatorId).not.toBeNull();
    expect(carriesManifest(picked.manifestHash)).toBe(true);
    expect(picked.attestations).toBeGreaterThan(0);
  });

  it("prefers the newest of two records that both carry everything", () => {
    const newer = row({ id: "0xfeedface", registeredAt: "1788999999", attestations: 3 });
    const chosen = chooseFocal([...INDEX, newer], [...ALL_PICTURED, true]);

    expect(chosen?.reason).toBe("full");
    expect([...INDEX, newer][(chosen as { index: number }).index].id).toBe("0xfeedface");
  });

  it("falls back to the newest agent record with a manifest when nothing has been re-checked", () => {
    const none = INDEX.map((entry) => ({ ...entry, attestations: 0 }));
    const chosen = chooseFocal(none, ALL_PICTURED);

    expect(chosen?.reason).toBe("manifest");

    const picked = none[(chosen as { index: number }).index];
    expect(picked.id).toBe("0x1d9dfdba");
    expect(picked.attestations).toBe(0);
    expect(carriesManifest(picked.manifestHash)).toBe(true);
  });

  it("falls back to the newest picture of any kind, and then carries no agent", () => {
    const plain = INDEX.map((entry) => ({ ...entry, kind: 1, generatorId: null, manifestHash: ZERO }));
    const chosen = chooseFocal(plain, ALL_PICTURED);

    expect(chosen?.reason).toBe("any");

    const picked = plain[(chosen as { index: number }).index];
    expect(picked.id).toBe("0x75bf8bf1");
    expect(focalFrom(picked, "https://gateway/picture", "any").agentId).toBeNull();
  });

  it("never follows a record with no picture", () => {
    const onlyOldest = INDEX.map((entry) => entry.id === "0xb328bab5");
    const chosen = chooseFocal(INDEX, onlyOldest);

    expect(INDEX[(chosen as { index: number }).index].id).toBe("0xb328bab5");
    expect(chooseFocal(INDEX, INDEX.map(() => false))).toBeNull();
  });

  it("gives every caption's figure out of the one chosen record", () => {
    const chosen = chooseFocal(INDEX, ALL_PICTURED) as { index: number; reason: "full" };
    const picked = INDEX[chosen.index];
    const focal = focalFrom(picked, "https://gateway/picture", chosen.reason);

    expect(focal.id).toBe(picked.id);
    expect(focal.agentId).toBe(picked.generatorId);
    expect(focal.block).toBe(picked.registeredBlock);
    expect(focal.registeredAt).toBe(Number(picked.registeredAt));
    expect(focal.creator).toBe(picked.creator);
    expect(focal.kind).toBe(picked.kind);
    expect(focal.manifest).toBe(true);
    expect(focal.attestations).toBe(picked.attestations);
    expect(focal.why).toBe("full");
  });

  it("takes the real picture over a seed card when both carry everything", () => {
    const rows = [
      row({ id: "0xcdb25d37", registeredAt: "1788881666", generatorId: "10249", attestations: 1 }),
      row({ id: "0x5f66c389", registeredAt: "1788999999", generatorId: "10248", attestations: 1 }),
    ];
    const titles = ["Monsoon Fishing Nets Drying", "Moolam seed 4"];

    const chosen = chooseFocal(rows, [true, true], titles);

    expect(chosen?.reason).toBe("full");
    expect(rows[(chosen as { index: number }).index].id).toBe("0xcdb25d37");
  });

  it("takes the newest of two real pictures that both carry everything", () => {
    const rows = [
      row({ id: "0xcdb25d37", registeredAt: "1788881666", generatorId: "10249", attestations: 1 }),
      row({ id: "0xdece558a", registeredAt: "1788881590", generatorId: "10249", attestations: 1 }),
    ];
    const titles = ["Monsoon Fishing Nets Drying", "Single-Light Jazz Trumpeter"];

    const chosen = chooseFocal(rows, [true, true], titles);

    expect(rows[(chosen as { index: number }).index].id).toBe("0xcdb25d37");
  });

  it("falls back to the seed card when no real picture carries all three", () => {
    const rows = [
      row({ id: "0x5f66c389", registeredAt: "1788876082", attestations: 1 }),
      row({ id: "0xcdb25d37", registeredAt: "1788881666", attestations: 0 }),
    ];
    const titles = ["Moolam seed 4", "Monsoon Fishing Nets Drying"];

    const chosen = chooseFocal(rows, [true, true], titles);

    expect(chosen?.reason).toBe("full");
    expect(rows[(chosen as { index: number }).index].id).toBe("0x5f66c389");
  });

  it("chooses exactly as it did before when no titles are handed over", () => {
    const withTitles = chooseFocal(INDEX, ALL_PICTURED, INDEX.map(() => null));
    const without = chooseFocal(INDEX, ALL_PICTURED);

    expect(without).toEqual(withTitles);
    expect(INDEX[(without as { index: number }).index].id).toBe("0x5f66c389");
  });

  it("treats a picture whose metadata would not load as a test card", () => {
    const rows = [
      row({ id: "0xcdb25d37", registeredAt: "1788881666", attestations: 1 }),
      row({ id: "0xdece558a", registeredAt: "1788881999", attestations: 1 }),
    ];

    const chosen = chooseFocal(rows, [true, true], ["Monsoon Fishing Nets Drying", null]);

    expect(rows[(chosen as { index: number }).index].id).toBe("0xcdb25d37");
  });

  it("reads a manifest hash of nothing but zeroes as no manifest", () => {
    expect(carriesManifest(ZERO)).toBe(false);
    expect(carriesManifest("0x0")).toBe(false);
    expect(carriesManifest(MANIFEST)).toBe(true);
  });
});
