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

  it("gives up after sixty seconds rather than holding the build open", async () => {
    vi.useFakeTimers();
    index.explorePassports.mockReturnValue(new Promise(() => undefined));

    const list = realPictureIds();
    await vi.advanceTimersByTimeAsync(60_000);

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

  it("gives up after ninety seconds rather than holding the build open", async () => {
    vi.useFakeTimers();
    index.sheetPage.mockReturnValue(new Promise(() => undefined));

    const held = holdExploreDefault();
    await vi.advanceTimersByTimeAsync(90_000);

    await expect(held).resolves.toBe(false);
  });
});

describe("the agents a build makes a page for", () => {
  it("is every generator the board would list", async () => {
    index.generatorStandings.mockResolvedValue([{ id: "10248" }, { id: "10249" }]);

    await expect(knownAgentIds()).resolves.toEqual(["10248", "10249"]);
  });

  it("is nothing at all when the index will not answer, after the retries a network failure gets", async () => {
    vi.useFakeTimers();
    index.generatorStandings.mockRejectedValue(new Error("fetch failed"));

    const list = knownAgentIds();
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(list).resolves.toEqual([]);
    expect(index.generatorStandings).toHaveBeenCalledTimes(4);
  });
});

// 21 September: a retired index address answered 404 on every build-time read, the
// production build passed anyway, and four pages shipped live-rendered on stale data
// until the next deploy. These prove the guard that failure took: a production build
// now throws on a read it cannot get, after patient retries, unless told on purpose
// to ship without the index.
describe("a production build, when the index will not answer", () => {
  afterEach(() => {
    delete process.env.NEXT_PHASE;
    delete process.env.MOOLAM_BUILD_WITHOUT_INDEX;
  });

  it("throws a message naming the failed read and the override, on a 404", async () => {
    process.env.NEXT_PHASE = "phase-production-build";
    index.explorePassports.mockRejectedValue(new Error("the Envio endpoint answered 404"));

    const error = await realPictureIds().catch((caught: unknown) => caught as Error);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("with no passport list");
    expect(error.message).toContain("NEXT_PUBLIC_ENVIO_GRAPHQL_URL");
    expect(error.message).toContain("MOOLAM_BUILD_WITHOUT_INDEX");
    expect(index.explorePassports).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 404: the address is wrong, not the moment", async () => {
    process.env.NEXT_PHASE = "phase-production-build";
    index.explorePassports.mockRejectedValue(new Error("the Envio endpoint answered 404"));

    await expect(realPictureIds()).rejects.toThrow();

    expect(index.explorePassports).toHaveBeenCalledTimes(1);
  });

  it("keeps trying a 429, and a 200 on the second attempt succeeds after one wait", async () => {
    vi.useFakeTimers();
    process.env.NEXT_PHASE = "phase-production-build";
    index.explorePassports
      .mockRejectedValueOnce(new Error("the Envio endpoint answered 429"))
      .mockResolvedValueOnce({ passports: PICTURES.map((id) => ({ id })), cursor: null });

    const list = realPictureIds();
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(list).resolves.toEqual(PICTURES);
    expect(index.explorePassports).toHaveBeenCalledTimes(2);
  });

  it("throws once the three retries a repeated 429 gets are used up", async () => {
    vi.useFakeTimers();
    process.env.NEXT_PHASE = "phase-production-build";
    index.explorePassports.mockRejectedValue(new Error("the Envio endpoint answered 429"));

    const list = realPictureIds();
    const rejection = expect(list).rejects.toThrow(/NEXT_PUBLIC_ENVIO_GRAPHQL_URL/);

    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(10_000);

    await rejection;
    expect(index.explorePassports).toHaveBeenCalledTimes(4);
  });

  it("logs loudly and falls back instead of throwing when the override is set", async () => {
    process.env.NEXT_PHASE = "phase-production-build";
    process.env.MOOLAM_BUILD_WITHOUT_INDEX = "1";
    index.explorePassports.mockRejectedValue(new Error("the Envio endpoint answered 404"));

    await expect(realPictureIds()).resolves.toEqual([]);

    const logged = vi.mocked(console.log).mock.calls.map(([line]) => String(line)).join("\n");
    expect(logged).toContain("MOOLAM_BUILD_WITHOUT_INDEX=1");
    expect(logged).toContain("NEXT_PUBLIC_ENVIO_GRAPHQL_URL");
  });

  it("logs and falls back outside a production build, even on a 404", async () => {
    index.explorePassports.mockRejectedValue(new Error("the Envio endpoint answered 404"));

    await expect(realPictureIds()).resolves.toEqual([]);
    expect(index.explorePassports).toHaveBeenCalledTimes(1);
  });
});
