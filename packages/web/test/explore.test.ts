import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NO_MANIFEST, passportWhere, searchPattern } from "@/lib/data/passports";
import { isTestCard, mergePlates, sortPlates } from "@/components/explore/sort";
import {
  DEFAULT_VIEW,
  EXPLORE_VIEWS,
  exploreHref,
  filterFor,
  impliedView,
  isMixedView,
  picturesFor,
  readExploreSearch,
} from "@/components/explore/query";

const ID = `0x${"1a".repeat(32)}`;

describe("what the index is asked for", () => {
  it("asks for everything when no chip is on", () => {
    expect(passportWhere({})).toEqual({});
  });

  it("names the kind the chip picked", () => {
    expect(passportWhere({ kind: 2 })).toEqual({ _and: [{ kind: { _eq: 2 } }] });
  });

  it("reads a manifest as the hash not being the zero word", () => {
    expect(passportWhere({ manifest: true })).toEqual({ _and: [{ manifestHash: { _neq: NO_MANIFEST } }] });
    expect(NO_MANIFEST).toBe(`0x${"0".repeat(64)}`);
  });

  it("reads a re-check as at least one attestation", () => {
    expect(passportWhere({ rechecked: true })).toEqual({ _and: [{ attestationCount: { _gt: 0 } }] });
  });

  it("stacks the chips, the agent and the search into one and", () => {
    expect(passportWhere({ kind: 0, disputed: true, generator: "10248", search: "0xAB" })).toEqual({
      _and: [
        { kind: { _eq: 0 } },
        { disputed: { _eq: true } },
        { generator_id: { _eq: "10248" } },
        { id: { _ilike: "0xab%" } },
      ],
    });
  });

  it("carries on from the cursor without dropping a passport that shared its second", () => {
    const where = passportWhere({}, { registeredAt: "1788945475", id: ID });
    expect(where).toEqual({
      _and: [
        {
          _or: [
            { registeredAt: { _lt: "1788945475" } },
            { _and: [{ registeredAt: { _eq: "1788945475" } }, { id: { _lt: ID } }] },
          ],
        },
      ],
    });
  });
});

describe("the search term the index can use", () => {
  it("matches an id from the front when the term looks like one", () => {
    expect(searchPattern("0x1A2b")).toBe("0x1a2b%");
  });

  it("matches anywhere inside an id when the term is a fragment", () => {
    expect(searchPattern(" 7fd ")).toBe("%7fd%");
  });

  it("has nothing to ask for when the box is empty", () => {
    expect(searchPattern("")).toBeNull();
    expect(searchPattern(undefined)).toBeNull();
    expect(searchPattern("   ")).toBeNull();
  });

  it("refuses to let a term widen its own query", () => {
    expect(searchPattern("%_\\")).toBeNull();
    expect(searchPattern("0x1a%")).toBe("0x1a%");
  });
});

describe("which pictures come first", () => {
  const plate = (id: string, registeredAt: number, title: string | null) => ({ id, registeredAt, title });

  it("knows the titles the seed and proof scripts write", () => {
    expect(isTestCard("Moolam seed 4")).toBe(true);
    expect(isTestCard("Moolam prove-it 2026-09-09T09:17:19.321Z")).toBe(true);
    expect(isTestCard("Moolam Privy proof, the edit")).toBe(true);
    expect(isTestCard("Mikasa")).toBe(false);
    expect(isTestCard("Monsoon Fishing Nets Drying")).toBe(false);
  });

  it("counts a plate whose metadata would not load as a test card", () => {
    expect(isTestCard(null)).toBe(true);
    expect(isTestCard("  ")).toBe(true);
  });

  it("puts every real picture over every seed card, newest first inside each", () => {
    const sorted = sortPlates([
      plate("0x01", 300, "Moolam seed 9"),
      plate("0x02", 100, "Mikasa"),
      plate("0x03", 200, null),
      plate("0x04", 150, "Blue Hour Quiet Greenhouse"),
    ]);

    expect(sorted.map((row) => row.id)).toEqual(["0x04", "0x02", "0x01", "0x03"]);
  });

  it("settles a tie inside one second on the id, so the same set lands the same way", () => {
    const sorted = sortPlates([plate("0x0a", 100, "One"), plate("0x0b", 100, "Two")]);
    expect(sorted.map((row) => row.id)).toEqual(["0x0b", "0x0a"]);
  });

  it("never shows a plate twice when load more overlaps", () => {
    const held = [plate("0x02", 200, "Mikasa"), plate("0x01", 100, "Greenhouse")];
    const merged = mergePlates(held, [plate("0x01", 100, "Greenhouse"), plate("0x00", 50, "Lighthouse")]);
    expect(merged.map((row) => row.id)).toEqual(["0x02", "0x01", "0x00"]);
  });
});

describe("the filter a link carries", () => {
  it("opens a bare address on the pictures", () => {
    expect(readExploreSearch({})).toEqual({ view: "pictures", search: "", agent: null });
    expect(DEFAULT_VIEW).toBe("pictures");
  });

  it("falls back to the chip the rest of the address implies when it names one this build lacks", () => {
    expect(readExploreSearch({ view: "sideways" })).toEqual({ view: "pictures", search: "", agent: null });
    expect(readExploreSearch({ view: "sideways", agent: "10248" })).toEqual({
      view: "all",
      search: "",
      agent: "10248",
    });
  });

  it("opens on the whole registry when the address already carries a search or an agent", () => {
    expect(readExploreSearch({ agent: "10248" }).view).toBe("all");
    expect(readExploreSearch({ q: "0xab" }).view).toBe("all");
    expect(impliedView("", null)).toBe("pictures");
    expect(impliedView("0xab", null)).toBe("all");
  });

  it("keeps the test chip when a link asks for it", () => {
    expect(readExploreSearch({ view: "test" })).toEqual({ view: "test", search: "", agent: null });
  });

  it("reads the chip, the term and the agent out of the URL", () => {
    expect(readExploreSearch({ view: "rechecked", q: " 0xAB ", agent: "10248" })).toEqual({
      view: "rechecked",
      search: "0xAB",
      agent: "10248",
    });
  });

  it("takes only digits for an agent id", () => {
    expect(readExploreSearch({ agent: "10248x'" }).agent).toBe("10248");
    expect(readExploreSearch({ agent: "none" }).agent).toBeNull();
  });

  it("turns each chip into the filter the index understands", () => {
    expect(filterFor({ view: "generated", search: "", agent: null })).toEqual({ kind: 0 });
    expect(filterFor({ view: "captured", search: "", agent: null })).toEqual({ kind: 1 });
    expect(filterFor({ view: "edits", search: "", agent: null })).toEqual({ kind: 2 });
    expect(filterFor({ view: "manifest", search: "", agent: null })).toEqual({ manifest: true });
    expect(filterFor({ view: "disputed", search: "", agent: null })).toEqual({ disputed: true });
    expect(filterFor({ view: "all", search: "0xab", agent: "10249" })).toEqual({
      search: "0xab",
      generator: "10249",
    });
  });

  it("asks for one half of the registry on the two picture chips and for both on every other", () => {
    expect(filterFor({ view: "pictures", search: "", agent: null })).toEqual({ pictures: "real" });
    expect(filterFor({ view: "test", search: "", agent: null })).toEqual({ pictures: "test" });
    expect(filterFor({ view: "all", search: "", agent: null })).toEqual({});
    expect(picturesFor("generated")).toBeUndefined();
    expect(isMixedView("all")).toBe(true);
    expect(isMixedView("pictures")).toBe(false);
    expect(isMixedView("test")).toBe(false);
  });

  it("keeps the real-versus-test split out of the index query, which has no title to match", () => {
    expect(passportWhere({ pictures: "real" })).toEqual({});
    expect(passportWhere({ pictures: "test", kind: 0 })).toEqual({ _and: [{ kind: { _eq: 0 } }] });
  });

  it("writes the whole state back into a link anyone can share", () => {
    expect(exploreHref({ view: "pictures", search: "", agent: null })).toBe("/explore");
    expect(exploreHref({ view: "all", search: "", agent: null })).toBe("/explore?view=all");
    expect(exploreHref({ view: "test", search: "", agent: null })).toBe("/explore?view=test");
    expect(exploreHref({ view: "edits", search: "0x1a", agent: "10248" })).toBe(
      "/explore?view=edits&q=0x1a&agent=10248",
    );
    expect(exploreHref({ view: "all", search: "", agent: "10248" })).toBe("/explore?agent=10248");
  });

  it("reads every link it writes back as the view it was copied from", () => {
    for (const view of EXPLORE_VIEWS) {
      for (const extra of [{ search: "", agent: null }, { search: "0xab", agent: null }, { search: "", agent: "10248" }]) {
        const state = { view, ...extra };
        const href = exploreHref(state);
        const params = Object.fromEntries(new URLSearchParams(href.split("?")[1] ?? ""));
        expect(readExploreSearch(params), href).toEqual(state);
      }
    }
  });
});

describe("the words the chips and the split line need", () => {
  const MESSAGES = fileURLToPath(new URL("../messages/", import.meta.url));

  it("says the new chip and the new line in every language the site serves", () => {
    const files = readdirSync(MESSAGES).filter((name) => name.endsWith(".json"));
    expect(files).toHaveLength(10);

    for (const file of files) {
      const explore = (
        JSON.parse(readFileSync(`${MESSAGES}${file}`, "utf8")) as {
          explore: { chips: Record<string, string>; sortNewest: string; split: Record<string, string> };
        }
      ).explore;

      for (const view of EXPLORE_VIEWS) {
        expect(explore.chips[view]?.length ?? 0, `${file} chips.${view}`).toBeGreaterThan(0);
      }
      expect(explore.sortNewest.length, file).toBeGreaterThan(0);
      expect(explore.split.real, file).toContain("{count, number}");
      expect(explore.split.test, file).toContain("{count, number}");
      expect(explore.split.testCapped, file).toContain("{scanned, number}");
    }
  });
});
