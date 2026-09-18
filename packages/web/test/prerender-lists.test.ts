import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const index = vi.hoisted(() => ({
  explorePassports: vi.fn(),
  generatorStandings: vi.fn(),
  heldRegistryCounts: vi.fn(),
  sheetPage: vi.fn(),
  heldPictureSplit: vi.fn(),
  source: "envio" as "envio" | "chain",
}));

vi.mock("@/lib/data/passports", () => ({
  explorePassports: index.explorePassports,
  generatorStandings: index.generatorStandings,
  heldRegistryCounts: index.heldRegistryCounts,
}));

vi.mock("@/lib/data/source", () => ({ activeSource: () => index.source }));

vi.mock("@/lib/chain/client", () => ({
  reason: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

// The sieve that tells a real picture from a seed test card reads a gateway per
// row. What it decides is the Explore sheet's own test, covered there; here it
// only has to be the thing this reader asks.
vi.mock("@/components/explore/plates", () => ({
  plateSheet: () => ({ keep: async (rows: unknown[]) => rows, platesFor: () => [] }),
  sheetPage: index.sheetPage,
  heldPictureSplit: index.heldPictureSplit,
}));

const { realPictureIds, knownAgentIds, holdExploreDefault } = await import("@/lib/data/prerender");
const { DEFAULT_SEARCH, readExploreSearch } = await import("@/components/explore/query");

const PICTURES = [`0x${"a1".repeat(32)}`, `0x${"b2".repeat(32)}`];

beforeEach(() => {
  index.explorePassports.mockReset();
  index.generatorStandings.mockReset();
  index.heldRegistryCounts.mockReset().mockResolvedValue({ total: 36, generated: 30, rechecked: 4, capped: false });
  index.sheetPage.mockReset().mockResolvedValue({ plates: [], cursor: null });
  index.heldPictureSplit.mockReset().mockResolvedValue({ real: 14, test: 22, scanned: 36, capped: false });
  index.source = "envio";
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the passports a build makes a page for", () => {
  it("is the real pictures the index answered with", async () => {
    index.explorePassports.mockResolvedValue({ passports: PICTURES.map((id) => ({ id })), cursor: null });

    await expect(realPictureIds()).resolves.toEqual(PICTURES);
    expect(index.explorePassports.mock.calls[0][0]).toMatchObject({ filter: { pictures: "real" } });
  });

  it("is nothing at all when the index will not answer, and the build carries on", async () => {
    index.explorePassports.mockRejectedValue(new Error("the Envio endpoint answered 502"));

    await expect(realPictureIds()).resolves.toEqual([]);
  });

  it("is nothing at all when there is no index configured", async () => {
    index.source = "chain";

    await expect(realPictureIds()).resolves.toEqual([]);
    expect(index.explorePassports).not.toHaveBeenCalled();
  });

  it("gives up after ten seconds rather than holding the build open", async () => {
    vi.useFakeTimers();
    index.explorePassports.mockReturnValue(new Promise(() => undefined));

    const list = realPictureIds();
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(list).resolves.toEqual([]);
  });
});

describe("the view Explore opens on, held while the site is built", () => {
  it("holds the three reads that view makes, under no chip, no term and no agent", async () => {
    await expect(holdExploreDefault()).resolves.toBe(true);

    expect(index.sheetPage).toHaveBeenCalledWith(DEFAULT_SEARCH);
    expect(index.heldRegistryCounts).toHaveBeenCalledTimes(1);
    expect(index.heldPictureSplit).toHaveBeenCalledTimes(1);
  });

  it("holds the view a bare address asks for, so the build and the page cannot drift apart", () => {
    expect(readExploreSearch({})).toEqual(DEFAULT_SEARCH);
  });

  it("goes without it when the index will not answer, and the build carries on", async () => {
    index.sheetPage.mockRejectedValue(new Error("the Envio endpoint answered 502"));

    await expect(holdExploreDefault()).resolves.toBe(false);
  });

  it("holds nothing when there is no index configured", async () => {
    index.source = "chain";

    await expect(holdExploreDefault()).resolves.toBe(false);
    expect(index.sheetPage).not.toHaveBeenCalled();
  });

  it("gives up after thirty seconds rather than holding the build open", async () => {
    vi.useFakeTimers();
    index.sheetPage.mockReturnValue(new Promise(() => undefined));

    const held = holdExploreDefault();
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(held).resolves.toBe(false);
  });
});

describe("the agents a build makes a page for", () => {
  it("is every generator the board would list", async () => {
    index.generatorStandings.mockResolvedValue([{ id: "10248" }, { id: "10249" }]);

    await expect(knownAgentIds()).resolves.toEqual(["10248", "10249"]);
  });

  it("is nothing at all when the index will not answer", async () => {
    index.generatorStandings.mockRejectedValue(new Error("fetch failed"));

    await expect(knownAgentIds()).resolves.toEqual([]);
  });
});
