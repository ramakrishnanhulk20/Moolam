import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";

/**
 * Two reads of the index that cost more than they had to.
 *
 * The agents roster is held under a name, and a name that leaves out how many
 * rows were asked for answers a caller wanting fifty with whatever five a
 * different caller put there. The verify page's samples asked the chain once
 * per candidate for a statement the index already carries on the row.
 */

const holds = vi.hoisted(() => ({
  names: [] as string[][],
  consent: vi.fn(),
  story: vi.fn(),
  art: vi.fn(),
}));

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => Promise<unknown>, keyParts: string[]) => {
    holds.names.push(keyParts);
    return fn;
  },
}));

vi.mock("@/lib/chain/client", () => ({
  chain: { readContract: vi.fn() },
  addresses: { registry: `0x${"1".repeat(40)}`, policy: `0x${"2".repeat(40)}`, consent: `0x${"3".repeat(40)}` },
  registryAbi: [],
  CACHE_TAGS: { index: "moolam-index", chain: "moolam-chain", metadata: "moolam-metadata" },
  HOLD_SECONDS: 60,
  LIST_HOLD_SECONDS: 600,
  METADATA_HOLD_SECONDS: 3600,
  DEPLOY_BLOCK: 1n,
  gatewayUrl: (uri: string) => uri,
  reason: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

vi.mock("@/lib/data/source", () => ({
  activeSource: () => "envio",
  envioUrl: () => "https://index.example/v1/graphql",
}));

vi.mock("@/components/story/data", () => ({ heldStory: holds.story }));
vi.mock("@/lib/chain/consent", async (real) => ({
  ...(await real<typeof import("@/lib/chain/consent")>()),
  heldConsent: holds.consent,
}));

const { heldGeneratorStandings } = await import("@/lib/data/passports");
const { offeredSamples } = await import("@/lib/data/offeredSamples");

const ID = (word: string): Hex => `0x${word.repeat(32)}` as Hex;

/** What the index answers, and the queries it was asked, for one test. */
function indexAnswers(data: unknown): { asked: string[] } {
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (_url: string, options: { body: string }) => {
    asked.push(JSON.parse(options.body).query as string);
    return { ok: true, status: 200, json: async () => ({ data }) } as Response;
  });
  return { asked };
}

beforeEach(() => {
  holds.names.length = 0;
  holds.consent.mockReset();
  holds.story.mockReset();
  holds.art.mockReset();
  vi.unstubAllGlobals();
});

describe("the name the agents roster is held under", () => {
  it("carries how many rows were asked for, so two limits are two answers", async () => {
    indexAnswers({ Generator: [] });

    await heldGeneratorStandings(50);
    await heldGeneratorStandings(5);
    // The board files it under the newest registration as well, so a new
    // passport is a new name and is read at once (WO-293a row 24).
    await heldGeneratorStandings(50, "0xnewest");

    const rosters = holds.names.filter((parts) => parts[0] === "moolam-generator-standings");
    expect(rosters).toEqual([
      ["moolam-generator-standings", "50", ""],
      ["moolam-generator-standings", "5", ""],
      ["moolam-generator-standings", "50", "0xnewest"],
    ]);
  });
});

describe("what the verify page's samples cost", () => {
  const plates = [
    { id: ID("11"), picture: "ipfs://one" },
    { id: ID("22"), picture: "ipfs://two" },
    { id: ID("33"), picture: "ipfs://three" },
  ];

  function rows(marks: { id: Hex; stated: boolean; summary: string; rechecks: number }[]) {
    return {
      Passport: marks.map((mark) => ({
        id: mark.id.toLowerCase(),
        metadataURI: "",
        attestationCount: mark.rechecks,
        consentStated: mark.stated,
        consentSummary: mark.summary,
      })),
    };
  }

  it("reads the statement off the index row and never asks the chain", async () => {
    holds.story.mockResolvedValue({ plates, error: null });
    const index = indexAnswers(
      rows([
        { id: ID("11"), stated: false, summary: "none", rechecks: 0 },
        { id: ID("22"), stated: true, summary: "open", rechecks: 0 },
        { id: ID("33"), stated: true, summary: "closed", rechecks: 2 },
      ]),
    );

    const { samples, error } = await offeredSamples();

    expect(holds.consent).not.toHaveBeenCalled();
    expect(index.asked).toHaveLength(1);
    expect(index.asked[0]).toContain("consentStated");
    expect(index.asked[0]).toContain("consentSummary");
    // Re-checked with a statement first, then stated, then silent, and nothing
    // dropped from the row.
    expect(samples.map((sample) => sample.id)).toEqual([ID("33"), ID("22"), ID("11")]);
    expect(error).toBe(null);
  });

  it("reads a summary word this build does not know as silence rather than as a statement", async () => {
    holds.story.mockResolvedValue({ plates, error: null });
    indexAnswers(
      rows([
        { id: ID("11"), stated: true, summary: "sometimes", rechecks: 0 },
        { id: ID("22"), stated: true, summary: "open", rechecks: 0 },
        { id: ID("33"), stated: false, summary: "none", rechecks: 0 },
      ]),
    );

    expect((await offeredSamples()).samples.map((sample) => sample.id)).toEqual([ID("22"), ID("11"), ID("33")]);
  });

  it("keeps the whole row when the index will not answer, and only loses the order", async () => {
    holds.story.mockResolvedValue({ plates, error: null });
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 502, json: async () => ({}) }) as Response);

    const { samples, error } = await offeredSamples();

    expect(samples.map((sample) => sample.id)).toEqual([ID("11"), ID("22"), ID("33")]);
    expect(error).toBe(null);
  });

  it("hands back the story's own words when the story itself could not be read", async () => {
    holds.story.mockResolvedValue({ plates: [], error: "the Envio endpoint answered 502" });

    expect(await offeredSamples()).toEqual({ samples: [], error: "the Envio endpoint answered 502" });
  });

  it("says nothing is wrong when the registry genuinely holds no pictures", async () => {
    holds.story.mockResolvedValue({ plates: [], error: null });

    expect(await offeredSamples()).toEqual({ samples: [], error: null });
  });
});
