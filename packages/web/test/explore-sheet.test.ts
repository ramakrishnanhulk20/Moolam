import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The half of the Explore page the index cannot answer on its own: which rows
 * are real pictures and which are the test cards the repository's own scripts
 * wrote. The split is a title in the pinned metadata, so the sheet has to read
 * the gateway while it pages, and these tests hold both ends of that: what comes
 * back, and how many times the gateway is asked.
 */

const INDEX_URL = "https://index.example/v1/graphql";

const reads = vi.fn();

vi.mock("@/components/passport/art", () => ({
  readArt: async (uri: string) => {
    reads(uri);
    return { title: uri.includes("seed") ? "Moolam seed 4" : `Picture ${uri}`, missing: false };
  },
}));

type Sheet = typeof import("@/components/explore/plates");
type Data = typeof import("@/lib/data/passports");
let sheet: Sheet;
let data: Data;

beforeAll(async () => {
  vi.stubEnv("NEXT_PUBLIC_ENVIO_GRAPHQL_URL", INDEX_URL);
  sheet = await import("@/components/explore/plates");
  data = await import("@/lib/data/passports");
});

afterEach(() => {
  vi.unstubAllGlobals();
  reads.mockClear();
});

/** One row as the index hands it over. Everything the grid does not read is left flat. */
function row(index: number, real: boolean) {
  return {
    id: `0x${index.toString(16).padStart(64, "0")}`,
    kind: 0,
    registeredAt: String(1_000 - index),
    registeredBlock: "42",
    metadataURI: real ? `ipfs://picture-${index}` : `ipfs://seed-${index}`,
    manifestHash: `0x${"0".repeat(64)}`,
    disputed: false,
    attestationCount: 0,
    attestations: [],
    generator: null,
  };
}

/**
 * An index holding exactly these rows, newest first, paging on the cursor the
 * query carries rather than on how many times it has been called.
 */
function indexHolding(rows: ReturnType<typeof row>[]) {
  const calls = vi.fn(async (_url: string, init: { body: string }) => {
    const { variables } = JSON.parse(init.body) as {
      variables: { where: Record<string, unknown>; limit: number };
    };
    const clauses = (variables.where._and ?? []) as Record<string, { _lt?: string }>[];
    const paging = clauses.find((clause) => "_or" in clause) as
      | { _or: [{ registeredAt: { _lt: string } }] }
      | undefined;
    const after = paging === undefined ? null : Number(paging._or[0].registeredAt._lt);
    const left = after === null ? rows : rows.filter((one) => Number(one.registeredAt) < after);

    return { ok: true, json: async () => ({ data: { Passport: left.slice(0, variables.limit) } }) } as unknown as Response;
  });

  vi.stubGlobal("fetch", calls);
  return calls;
}

describe("opening the sheet on the real pictures", () => {
  it("keeps reading past pages of test cards until it has pictures, and says where it stopped", async () => {
    const rows = [...Array(9).keys()].map((index) => row(index, false));
    rows.push(row(9, true), row(10, true), row(11, true));
    const calls = indexHolding(rows);

    const sift = sheet.plateSheet("real");
    const page = await data.explorePassports({ filter: { pictures: "real" }, limit: 4, keep: sift.keep });
    const plates = sift.platesFor(page.passports);

    expect(plates.map((plate) => plate.title)).toEqual([
      "Picture ipfs://picture-9",
      "Picture ipfs://picture-10",
      "Picture ipfs://picture-11",
    ]);
    expect(page.cursor).toBeNull();
    expect(calls).toHaveBeenCalledTimes(4);
  });

  it("shows the test cards on their own under the other chip", async () => {
    const rows = [row(0, true), row(1, false), row(2, true), row(3, false)];
    indexHolding(rows);

    const sift = sheet.plateSheet("test");
    const page = await data.explorePassports({ filter: { pictures: "test" }, limit: 4, keep: sift.keep });

    expect(sift.platesFor(page.passports).map((plate) => plate.id)).toEqual([rows[1].id, rows[3].id]);
  });

  it("reads the index once and drops nothing when the chip asks for both", async () => {
    const rows = [row(0, true), row(1, false), row(2, false), row(3, false)];
    const calls = indexHolding(rows);

    const sift = sheet.plateSheet(undefined);
    const page = await data.explorePassports({ filter: {}, limit: 4, keep: sift.keep });

    expect(sift.platesFor(page.passports)).toHaveLength(4);
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it("reads the gateway once per row, whether the row was sifted out or drawn", async () => {
    const rows = [row(0, true), row(1, false), row(2, true), row(3, false)];
    indexHolding(rows);

    const sift = sheet.plateSheet("real");
    const page = await data.explorePassports({ filter: { pictures: "real" }, limit: 4, keep: sift.keep });
    sift.platesFor(page.passports);

    expect(reads).toHaveBeenCalledTimes(4);
  });

  it("stops at the scan cap with a cursor rather than walking the whole registry in one render", async () => {
    const calls = indexHolding([...Array(100).keys()].map((index) => row(index, false)));

    const sift = sheet.plateSheet("real");
    const page = await data.explorePassports({ filter: { pictures: "real" }, limit: 4, keep: sift.keep });

    expect(sift.platesFor(page.passports)).toHaveLength(0);
    expect(calls).toHaveBeenCalledTimes(8);
    expect(page.cursor).not.toBeNull();
  });
});

describe("the line that says how the registry divides", () => {
  it("counts the pictures and the test cards over the whole index", async () => {
    const rows = [row(0, true), row(1, false), row(2, true), row(3, false), row(4, false)];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: { Passport: rows.map((one) => ({ id: one.id, metadataURI: one.metadataURI })) },
        }),
      }) as unknown as Response),
    );

    expect(await sheet.pictureSplit()).toEqual({ real: 2, test: 3, scanned: 5, capped: false });
  });

  it("says its two numbers cover the newest rows when the read hit the cap", async () => {
    const rows = [...Array(data.SPLIT_CAP).keys()].map((index) => row(index, true));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: { Passport: rows.map((one) => ({ id: one.id, metadataURI: one.metadataURI })) },
        }),
      }) as unknown as Response),
    );

    const split = await sheet.pictureSplit();
    expect(split).toEqual({ real: data.SPLIT_CAP, test: 0, scanned: data.SPLIT_CAP, capped: true });
  });
});

describe("the disputed mark on a plate", () => {
  it("lights on an edit whose picture was disputed, which the index row itself does not say", async () => {
    const rows = [row(0, true), row(1, true)];
    indexHolding(rows);

    const sift = sheet.plateSheet(undefined);
    const page = await data.explorePassports({
      filter: { disputedReach: { ids: [rows[1].id] } },
      limit: 4,
      keep: sift.keep,
    });

    expect(sift.platesFor(page.passports).map((plate) => plate.disputed)).toEqual([false, true]);
  });

  it("takes the index's own field when the schema has it", async () => {
    const rows = [{ ...row(0, true), inheritedDisputed: true }];
    indexHolding(rows);

    const sift = sheet.plateSheet(undefined);
    const page = await data.explorePassports({ filter: { disputedReach: "field" }, limit: 4, keep: sift.keep });

    expect(sift.platesFor(page.passports).map((plate) => plate.disputed)).toEqual([true]);
  });
});
