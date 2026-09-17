import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";

/**
 * The field of plates on the first screen.
 *
 * The screenshot that started this had the seed test cards outnumbering the
 * real pictures three to one on the opening shot. The rule is now the same one
 * Explore and the build's page list read: the title in the pinned metadata
 * decides, and nothing takes a dropped plate's place.
 */

const INDEX_URL = "https://index.example/v1/graphql";

// Next's cache needs a request behind it, which a node test has none of. The
// field does not care whether an answer was held, only what it holds.
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => Promise<unknown>) => fn,
}));

vi.mock("@/lib/chain/registry", () => ({
  getAttestations: async () => [],
  getPassport: async () => null,
}));

vi.mock("@/lib/data/passports", () => ({
  latestPassports: async () => ({ passports: [] }),
  generatorRecord: async () => null,
}));

type Story = typeof import("@/components/story/data");
let story: Story;

beforeAll(async () => {
  vi.stubEnv("NEXT_PUBLIC_ENVIO_GRAPHQL_URL", INDEX_URL);
  story = await import("@/components/story/data");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

type Row = { id: Hex; metadataURI: string; title: string | null };

/** One row as the index hands it over, with the name its document carries. */
function row(at: number, title: string | null): Row {
  return {
    id: `0x${at.toString(16).padStart(64, "0")}` as Hex,
    metadataURI: `ipfs://document-${at}`,
    title,
  };
}

/**
 * An index holding exactly these rows, and a gateway serving the document each
 * one points at. The limit the query asked for is handed back so the test can
 * hold the field's own depth.
 */
function registryHolding(rows: Row[]): { limit: () => number } {
  const asked = { at: 0 };
  const documents = new Map(rows.map((one) => [one.metadataURI, one]));

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { body?: string }) => {
      if (url === INDEX_URL) {
        asked.at = (JSON.parse(init?.body ?? "{}") as { variables: { limit: number } }).variables.limit;
        return {
          ok: true,
          json: async () => ({
            data: {
              Passport: rows.slice(0, asked.at).map((one, at) => ({
                id: one.id,
                metadataURI: one.metadataURI,
                registeredAt: String(1_789_000_000 - at * 60),
                registeredBlock: "103057874",
                generator_id: "10248",
                creator_id: `0x${"11".repeat(20)}`,
                kind: 0,
                manifestHash: `0x${"a7".repeat(32)}`,
                attestationCount: 1,
              })),
              GlobalStats: [{ passports: rows.length, attestations: 4 }],
              Generator: [{ id: "10248", passportCount: 9, matchedCount: 3, trustScore: 88 }],
            },
          }),
        } as unknown as Response;
      }

      const uri = [...documents.keys()].find((key) => url.endsWith(key.replace("ipfs://", "")));
      const document = uri === undefined ? undefined : documents.get(uri);
      if (document === undefined) {
        return { ok: false, status: 404 } as unknown as Response;
      }
      return {
        ok: true,
        json: async () => ({
          name: document.title,
          image: `ipfs://image-${document.id}`,
          thumbnail: `ipfs://thumb-${document.id}`,
        }),
      } as unknown as Response;
    }),
  );

  return { limit: () => asked.at };
}

/** Sixteen seed cards at the top of the index with the real pictures under them. */
function buried(real: number): Row[] {
  return [
    ...Array.from({ length: 16 }, (_, at) => row(at, `Moolam seed ${at}`)),
    ...Array.from({ length: real }, (_, at) => row(100 + at, `Monsoon Fishing Nets ${at}`)),
  ];
}

describe("what the first screen floats", () => {
  it("answers eight plates from an index whose newest sixteen rows are seed cards", async () => {
    const rows = buried(8);
    const index = registryHolding(rows);

    const data = await story.storyData();

    expect(index.limit()).toBe(24);
    expect(data.plates).toHaveLength(8);
    expect(data.plates.map((plate) => plate.id)).toEqual(rows.slice(16).map((one) => one.id));
    expect(data.plates.some((plate) => plate.picture.includes("seed"))).toBe(false);
  });

  it("grows with the registry: thirteen real rows answer thirteen plates", async () => {
    registryHolding([...buried(13)].slice(11));

    expect((await story.storyData()).plates).toHaveLength(13);
  });

  it("drops a document with no name at all rather than floating an unnamed plate", async () => {
    registryHolding([row(0, null), row(1, "Single-Light Jazz Trumpeter"), row(2, "")]);

    const data = await story.storyData();

    expect(data.plates.map((plate) => plate.id)).toEqual([row(1, null).id]);
  });

  it("hands back a shorter field rather than filling it with test cards", async () => {
    registryHolding(buried(0));

    expect((await story.storyData()).plates).toEqual([]);
  });
});
