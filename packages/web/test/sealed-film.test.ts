import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";

/**
 * The film on the home page, when one of the newest passports is sealed.
 *
 * The film is a reel of registered pictures. A sealed passport has none, so it
 * is left out on purpose rather than taking a plate's place and drawing an
 * empty frame in the middle of a row of stills. Everywhere it does appear, it
 * is drawn as the sealed record it is.
 */

const INDEX_URL = "https://index.example/v1/graphql";

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

interface Row {
  id: Hex;
  metadataURI: string;
  title: string;
  sealed: boolean;
}

function row(at: number, title: string, sealed = false): Row {
  return { id: `0x${at.toString(16).padStart(64, "0")}` as Hex, metadataURI: `ipfs://document-${at}`, title, sealed };
}

/** An index holding these rows, and a gateway serving the document behind each one. */
function registryHolding(rows: Row[]): void {
  const documents = new Map(rows.map((one) => [one.metadataURI, one]));

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { body?: string }) => {
      if (url === INDEX_URL) {
        const limit = (JSON.parse(init?.body ?? "{}") as { variables: { limit: number } }).variables.limit;
        return {
          ok: true,
          json: async () => ({
            data: {
              Passport: rows.slice(0, limit).map((one, at) => ({
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
        json: async () =>
          document.sealed
            ? {
                name: document.title,
                sealed: true,
                commitment: { algorithm: "sha-256", value: document.id },
                fingerprint: { blockhash: `0x${"1f".repeat(32)}` },
              }
            : {
                name: document.title,
                image: `ipfs://image-${document.id}`,
                thumbnail: `ipfs://thumb-${document.id}`,
              },
      } as unknown as Response;
    }),
  );
}

describe("a sealed passport and the film", () => {
  it("is left out of the plates, and the pictures around it keep their places", async () => {
    const rows = [
      row(1, "Monsoon nets, Kovalam", true),
      row(2, "Kadal at dawn"),
      row(3, "Single-Light Jazz Trumpeter"),
    ];
    registryHolding(rows);

    const data = await story.storyData();

    expect(data.plates.map((plate) => plate.id)).toEqual([rows[1].id, rows[2].id]);
  });

  it("makes the field shorter rather than drawing a frame with nothing in it", async () => {
    registryHolding([row(1, "Monsoon nets, Kovalam", true)]);

    expect((await story.storyData()).plates).toEqual([]);
  });
});
