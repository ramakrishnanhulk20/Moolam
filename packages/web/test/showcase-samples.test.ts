import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { SHOWCASE } from "@/lib/data/showcase";

/**
 * The three pictures the home page and the verify page offer are the
 * hand-picked showcase set, in order, and the newest pictures only fill a slot
 * whose pick cannot be read. Everything upstream is held in place here: the
 * story's plates, the one index query and the gateway's documents.
 */

const holds = vi.hoisted(() => ({
  story: vi.fn(),
  ask: vi.fn(),
  art: vi.fn(),
}));

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => Promise<unknown>) => fn,
}));

vi.mock("@/lib/chain/client", () => ({
  CACHE_TAGS: { index: "moolam-index", chain: "moolam-chain", metadata: "moolam-metadata" },
  HOLD_SECONDS: 60,
  LIST_HOLD_SECONDS: 600,
}));

vi.mock("@/components/story/data", () => ({ heldStory: holds.story }));
vi.mock("@/lib/data/passports", () => ({ askIndex: holds.ask, heldArt: holds.art }));

const { offeredSamples } = await import("@/lib/data/offeredSamples");

const ID = (word: string): Hex => `0x${word.repeat(32)}` as Hex;
const [MONSOON, MOON, KITES] = SHOWCASE;

const plates = [
  { id: ID("11"), picture: "https://gw/ipfs/one" },
  { id: ID("22"), picture: "https://gw/ipfs/two" },
  { id: ID("33"), picture: "https://gw/ipfs/three" },
  { id: ID("44"), picture: "https://gw/ipfs/four" },
];

const doc = (id: string) => `ipfs://doc-${id.toLowerCase()}`;
const thumb = (id: string) => `https://gw/ipfs/thumb-${id.toLowerCase()}`;

/** The index answers a row for every id it is asked about, each pointing at its own document. */
function indexAnswers(): void {
  holds.ask.mockImplementation(async (_query: string, variables: { ids: string[] }) => ({
    Passport: variables.ids.map((id) => ({
      id,
      metadataURI: doc(id),
      attestationCount: 0,
      consentStated: false,
      consentSummary: "none",
    })),
  }));
}

/** The gateway hands back each pick's document as named, unless a pick is told otherwise. */
function gatewayAnswers(overrides: Record<string, { title?: string; thumbnailUrl?: string } | "quiet"> = {}): void {
  holds.art.mockImplementation(async (uri: string) => {
    const pick = SHOWCASE.find((one) => doc(one.id) === uri);
    if (pick === undefined) {
      return { title: `Plate ${uri.slice(-4)}` };
    }
    const override = overrides[pick.id];
    if (override === "quiet") {
      throw new Error("the gateway would not answer");
    }
    return { title: pick.title, thumbnailUrl: thumb(pick.id), ...override };
  });
}

beforeEach(() => {
  holds.story.mockReset();
  holds.ask.mockReset();
  holds.art.mockReset();
  holds.story.mockResolvedValue({ plates, error: null });
});

describe("the showcase set the samples are offered from", () => {
  it("offers the three picks, in order, under their own titles, when the index and the gateway answer", async () => {
    indexAnswers();
    gatewayAnswers();

    const { samples, error } = await offeredSamples();

    expect(samples).toEqual([
      { id: MONSOON.id, url: thumb(MONSOON.id), title: "Monsoon Fishing Nets Drying" },
      { id: MOON.id, url: thumb(MOON.id), title: "A human standing alone in the moon." },
      { id: KITES.id, url: thumb(KITES.id), title: "Marina Beach Kite Sellers at Dusk" },
    ]);
    expect(error).toBe(null);
  });

  it("reads every pick in the one index query the candidates ride in, never a query each", async () => {
    indexAnswers();
    gatewayAnswers();

    await offeredSamples();

    expect(holds.ask).toHaveBeenCalledTimes(1);
    const asked = holds.ask.mock.calls[0][1] as { ids: string[] };
    for (const entry of [...SHOWCASE, ...plates]) {
      expect(asked.ids).toContain(entry.id.toLowerCase());
    }
  });

  it("hands a pick whose document carries another title its slot's place to the newest picture", async () => {
    indexAnswers();
    gatewayAnswers({ [MOON.id]: { title: "Someone else's moon" } });

    const { samples } = await offeredSamples();

    expect(samples.map((sample) => sample.id)).toEqual([MONSOON.id, ID("11"), KITES.id]);
  });

  it("fills the slot of a pick whose picture cannot be read, in place, without repeating a picture", async () => {
    indexAnswers();
    gatewayAnswers({ [MONSOON.id]: "quiet", [KITES.id]: { thumbnailUrl: undefined } });

    const { samples } = await offeredSamples();

    expect(samples.map((sample) => sample.id)).toEqual([ID("11"), MOON.id, ID("22")]);
    const urls = samples.map((sample) => sample.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("never offers a newest plate that is the same picture as a pick that held its slot", async () => {
    indexAnswers();
    gatewayAnswers({ [MONSOON.id]: { thumbnailUrl: "https://gw/ipfs/one" }, [MOON.id]: "quiet" });

    const { samples } = await offeredSamples();

    expect(samples.map((sample) => sample.id)).toEqual([MONSOON.id, ID("22"), KITES.id]);
  });

  it("still offers the newest three when the index will not answer", async () => {
    holds.ask.mockRejectedValue(new Error("the Envio endpoint answered 502"));
    gatewayAnswers();

    const { samples, error } = await offeredSamples();

    expect(samples.map((sample) => sample.id)).toEqual([ID("11"), ID("22"), ID("33")]);
    expect(holds.art).not.toHaveBeenCalled();
    expect(error).toBe(null);
  });
});
