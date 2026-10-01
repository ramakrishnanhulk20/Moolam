import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import en from "@/messages/en.json";
import type { IndexRow, StoryData } from "@/components/story/data";

/**
 * The story-v2 roll-in (WO-279c): the film tells Ram's approved script, light
 * by default, on the head chef's picture, and a beat or a line is only ever in
 * the film when the read behind it came back and the thing it shows is live.
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

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
  useRouter: () => ({ refresh: () => undefined }),
  usePathname: () => "/",
}));

vi.mock("@/components/passport/Picture", () => ({
  Picture: (props: { sources: string[] }) => createElement("span", { "data-picture": props.sources[0] }),
}));

type Data = typeof import("@/components/story/data");
let story: Data;
let stated: typeof import("@/components/story/stated");
let palette: typeof import("@/components/story/palette");
let room: typeof import("@/components/story/room");
let LandingStory: typeof import("@/components/story/LandingStory").LandingStory;

beforeAll(async () => {
  vi.stubEnv("NEXT_PUBLIC_ENVIO_GRAPHQL_URL", INDEX_URL);
  story = await import("@/components/story/data");
  stated = await import("@/components/story/stated");
  palette = await import("@/components/story/palette");
  room = await import("@/components/story/room");
  ({ LandingStory } = await import("@/components/story/LandingStory"));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function render(node: ReactElement): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;
  return renderToStaticMarkup(createElement(Provider, { locale: "en", messages: en, timeZone: "UTC" }, node));
}

const MANIFEST = `0x${"a7".repeat(32)}` as Hex;
const PINNED = "0xcdb25d3755452efa3b746f168cf9cefd3a1b693ab2b81d260a2d64f13d771638" as Hex;

function row(id: string, over: Partial<IndexRow> = {}): IndexRow {
  return {
    id: id as Hex,
    metadataURI: `ipfs://document-${id}`,
    registeredAt: "1789000000",
    registeredBlock: "103057874",
    generatorId: "10249",
    creator: "0x85a88ca81ff5f681d96ab86fa60ccb8452a139a6" as Hex,
    kind: 0,
    manifestHash: MANIFEST,
    attestations: 1,
    ...over,
  };
}

describe("the pinned picture", () => {
  const rows = [row("0x01"), row("0x02"), row("0x03")];
  const pictured = [true, true, true];

  it("is found by its title among the film's rows when it passes every rule", () => {
    expect(story.pinnedFocal(rows, pictured, ["A", "Monsoon Fishing Nets Drying", "C"], "Monsoon Fishing Nets Drying")).toBe(1);
  });

  it("is passed over when it is missing, has no picture, no Chainlink verdict, no agent or no credentials", () => {
    const title = "Monsoon Fishing Nets Drying";
    const titles = [null, title, null];
    expect(story.pinnedFocal(rows, pictured, ["A", "B", "C"], title)).toBeNull();
    expect(story.pinnedFocal(rows, [true, false, true], titles, title)).toBeNull();
    expect(story.pinnedFocal([rows[0], row("0x02", { attestations: 0 }), rows[2]], pictured, titles, title)).toBeNull();
    expect(story.pinnedFocal([rows[0], row("0x02", { generatorId: null }), rows[2]], pictured, titles, title)).toBeNull();
    expect(story.pinnedFocal([rows[0], row("0x02", { kind: 1 }), rows[2]], pictured, titles, title)).toBeNull();
    expect(story.pinnedFocal([rows[0], row("0x02", { manifestHash: `0x${"0".repeat(64)}` as Hex }), rows[2]], pictured, titles, title)).toBeNull();
  });

  it("is the head chef's pick, by id and title, in one place", () => {
    expect(story.PINNED_FOCAL).toEqual({ id: PINNED, title: "Monsoon Fishing Nets Drying" });
  });
});

/** An index whose newest rows are the given ones, with the pinned row read in the same query. */
function indexHolding(rows: { id: Hex; title: string; registeredAt: number; attestations?: number }[], pinned: { title: string; attestations: number } | null) {
  const documents = new Map<string, string>();
  const line = (one: { id: Hex; registeredAt: number; attestations?: number }) => ({
    id: one.id,
    metadataURI: `ipfs://document-${one.id}`,
    registeredAt: String(one.registeredAt),
    registeredBlock: "103057874",
    generator_id: "10249",
    creator_id: "0x85a88ca81ff5f681d96ab86fa60ccb8452a139a6",
    kind: 0,
    manifestHash: MANIFEST,
    attestationCount: one.attestations ?? 1,
  });
  for (const one of rows) {
    documents.set(`document-${one.id}`, one.title);
  }
  if (pinned !== null) {
    documents.set(`document-${PINNED}`, pinned.title);
  }

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { body?: string }) => {
      if (url === INDEX_URL) {
        const body = JSON.parse(init?.body ?? "{}") as { variables?: { limit?: number; pinned?: string } };
        if (body.variables?.limit === undefined) {
          return { ok: true, json: async () => ({ data: {} }) } as unknown as Response;
        }
        return {
          ok: true,
          json: async () => ({
            data: {
              pinned:
                pinned === null || body.variables?.pinned !== PINNED
                  ? []
                  : [line({ id: PINNED, registeredAt: 1_788_881_666, attestations: pinned.attestations })],
              Passport: rows.map(line),
              GlobalStats: [{ passports: 54, attestations: 33 }],
              Generator: [{ id: "10249", passportCount: 30, matchedCount: 20, trustScore: 95 }],
            },
          }),
        } as unknown as Response;
      }
      const key = [...documents.keys()].find((name) => url.endsWith(name));
      if (key === undefined) {
        return { ok: false, status: 404 } as unknown as Response;
      }
      return {
        ok: true,
        json: async () => ({ name: documents.get(key), image: `ipfs://image-${key}`, thumbnail: `ipfs://thumb-${key}` }),
      } as unknown as Response;
    }),
  );
}

describe("the picture the film is told on", () => {
  const newest = [
    { id: `0x${"aa".repeat(32)}` as Hex, title: "God of War Kratos", registeredAt: 1_790_836_997 },
    { id: `0x${"bb".repeat(32)}` as Hex, title: "Clockwork hummingbird", registeredAt: 1_790_769_747 },
  ];

  it("is the pinned picture, read in the film's own query even when it has fallen out of the newest rows", async () => {
    indexHolding(newest, { title: "Monsoon Fishing Nets Drying", attestations: 1 });
    const data = await story.storyData();
    expect(data.focal?.id).toBe(PINNED);
    expect(data.focal?.pinned).toBe(true);
    expect(data.focal?.title).toBe("Monsoon Fishing Nets Drying");
    // It never joins the field it was read beside.
    expect(data.plates.map((plate) => plate.id)).toEqual(newest.map((one) => one.id));
  });

  it("falls back to the automatic choice when the pinned picture cannot be read", async () => {
    indexHolding(newest, null);
    const data = await story.storyData();
    expect(data.focal?.id).toBe(newest[0].id);
    expect(data.focal?.pinned).toBe(false);
  });

  it("falls back when the pinned picture no longer passes, or its title is not the one pinned", async () => {
    indexHolding(newest, { title: "Monsoon Fishing Nets Drying", attestations: 0 });
    expect((await story.storyData()).focal?.id).toBe(newest[0].id);
    indexHolding(newest, { title: "Something else entirely", attestations: 1 });
    expect((await story.storyData()).focal?.id).toBe(newest[0].id);
  });

  it("credits the person for a studio picture, and names the agent only as the one that drew it", async () => {
    indexHolding(newest, { title: "Monsoon Fishing Nets Drying", attestations: 1 });
    expect((await story.storyData()).focal?.credit).toEqual({ case: "studio" });
  });
});

const WRITER = "0x85a88Ca81ff5f681D96AB86fa60ccB8452A139a6" as Hex;

function day(over: Partial<StoryData> = {}): StoryData {
  return {
    source: "envio",
    plates: [],
    focal: {
      id: PINNED,
      picture: "https://example.test/picture.jpg",
      creator: WRITER,
      agentId: "10249",
      registeredAt: 1_788_881_666,
      block: "103076351",
      kind: 0,
      manifest: true,
      attestations: 1,
      why: "full",
      measured: false,
      title: "Monsoon Fishing Nets Drying",
      pinned: true,
      credit: { case: "studio" },
      sworn: false,
    },
    attestation: { passportId: PINNED, matched: true, distance: 0, receiver: WRITER, at: 1_789_368_639 },
    agent: { id: "10249", rechecks: 20, score: 95, passports: 30 },
    statement: null,
    statementError: null,
    passportCount: 54,
    attestationCount: 33,
    error: null,
    check: { form: "test", matched: true, distance: 0, at: 1_789_368_639 },
    lookalike: null,
    yourself: null,
    ...over,
  };
}

/** The still page's sections, which is what a server draws of the film: one per beat in the cut. */
function beatsOf(html: string): string[] {
  return [...html.matchAll(/data-still-beat="([a-z]+)"/g)].map((found) => found[1]);
}

describe("gating by data", () => {
  it("leaves out the look-alike and waiting beats until their data exists", () => {
    const cut = stated.filmCut(day());
    expect(cut).not.toContain("lookalike");
    expect(cut).not.toContain("waiting");
    expect(stated.WAITING_SHIPPED).toBe(false);
    const html = render(createElement(LandingStory, { data: day(), variant: "chapter" as const }));
    expect(beatsOf(html)).not.toContain("lookalike");
    expect(beatsOf(html)).not.toContain("waiting");
    expect(html).not.toContain(en.story.lookalike.title);
    expect(html).not.toContain(en.story.waiting.title);
  });

  it("plays the look-alike beat once a network record with two pictures is there", () => {
    const lookalike = {
      earlier: { id: PINNED, picture: "https://example.test/a.jpg", title: "First", registeredAt: 1_788_000_000 },
      later: { id: `0x${"cc".repeat(32)}` as Hex, picture: "https://example.test/b.jpg", title: "Second", registeredAt: 1_788_000_000 + 3 * 86_400 },
      bits: 2,
      at: 1_790_900_000,
    };
    expect(stated.filmCut(day({ lookalike }))).toContain("lookalike");
    const html = render(createElement(LandingStory, { data: day({ lookalike }), variant: "chapter" as const }));
    expect(html).toContain("Second was registered 3 days after First. 2 of 64 bits apart");
    expect(html).toContain(en.story.lookalike.aside);
  });

  it("plays the checked beat in its honest test form until a network verdict exists, with the score as one small line", () => {
    const html = render(createElement(LandingStory, { data: day(), variant: "chapter" as const }));
    expect(html).toContain(en.story.checked.testTitle);
    expect(html).toContain("This run was a test on one machine.");
    expect(html).not.toContain(en.story.checked.title);
    expect(html).not.toContain(en.story.checked.mark);
    expect(html).toContain("Agent 10249&#x27;s score: 95");
  });

  it("turns the mark on only for a verdict Chainlink's network delivered", () => {
    const html = render(createElement(LandingStory, { data: day({ check: { form: "network", matched: true, distance: 0, at: 1_791_000_000 } }), variant: "chapter" as const }));
    expect(html).toContain(en.story.checked.title);
    expect(html).toContain(en.story.checked.mark);
    expect(html).toContain("Checked by Chainlink on");
    expect(html).not.toContain("This run was a test");
  });

  it("says what was done and claims neither when the delivery could not be told", () => {
    const html = render(createElement(LandingStory, { data: day({ check: { form: "plain", matched: true, distance: 0, at: 1 } }), variant: "chapter" as const }));
    expect(html).toContain(en.story.checked.testTitle);
    expect(html).not.toContain("This run was a test");
    expect(html).not.toContain(en.story.checked.mark);
  });

  it("leaves the checked beat out when this passport has no Chainlink verdict", () => {
    expect(stated.filmCut(day({ attestation: null, check: null }))).not.toContain("checked");
  });

  it("writes the sworn line only when the passport's own document carries it", () => {
    const without = render(createElement(LandingStory, { data: day(), variant: "chapter" as const }));
    expect(without).not.toContain(en.story.sealed.readoutSworn);
    const focal = { ...day().focal!, sworn: true };
    const sworn = render(createElement(LandingStory, { data: day({ focal }), variant: "chapter" as const }));
    expect(sworn).toContain(en.story.sealed.readoutSworn);
  });

  it("plays sign it yourself only on a co-signed picture, with the index's own counts", () => {
    expect(stated.filmCut(day())).not.toContain("yourself");
    const yourself = {
      platform: "Dreamloom",
      count: 11,
      platforms: 1,
      newest: { id: `0x${"dd".repeat(32)}` as Hex, picture: "https://example.test/d.jpg", title: "A drunk man driving", creator: WRITER },
    };
    const html = render(createElement(LandingStory, { data: day({ yourself }), variant: "chapter" as const }));
    expect(beatsOf(html)).toContain("yourself");
    expect(html).toContain("11 pictures drawn on 1 platform. Newest: A drunk man driving.");
  });

  it("credits the person, by the credit case, and never the tool", () => {
    const studio = render(createElement(LandingStory, { data: day(), variant: "chapter" as const }));
    expect(studio).toContain(en.story.imagined.title);
    expect(studio).toContain("Agent 10249 drew it.");
    expect(studio).toContain("Imagined by 0x85a8");
    const photo = render(
      createElement(LandingStory, { data: day({ focal: { ...day().focal!, kind: 1, agentId: null, credit: { case: "photo" } } }), variant: "chapter" as const }),
    );
    expect(photo).toContain(en.story.imagined.titlePhoto);
    const held = render(
      createElement(LandingStory, { data: day({ focal: { ...day().focal!, credit: { case: "platform", platform: "Dreamloom" } } }), variant: "chapter" as const }),
    );
    expect(held).toContain("Drawn by Dreamloom&#x27;s agent.");
    expect(held).not.toContain("Imagined by");
    // The held and handed wording is push day's, so it is never said.
    expect(held).not.toContain("holds it until the person who imagined it claims it");
  });

  it("plays every beat of the script in the script's order on a day with all of it", () => {
    const all = day({
      statement: {
        summary: "closed",
        consent: { aiTraining: "notAllowed", aiGenerativeTraining: "notAllowed", aiInference: "notAllowed", dataMining: "notAllowed" },
        at: 1_789_717_128,
        writer: WRITER,
        constraintInfo: "",
      },
    });
    expect(stated.filmCut(all)).toEqual(["opening", "imagined", "sealed", "stated", "asked", "shared", "verified", "checked", "offer", "close"]);
  });
});

describe("light by default", () => {
  it("is the light room for a reader who chose nothing, and for a page with no script", () => {
    expect(palette.roomOf(undefined)).toBe("light");
    expect(palette.roomOf("system")).toBe("light");
    expect(palette.roomOf("dark")).toBe("dark");
    expect(palette.roomPalette("light").ground).toBe("#e4ddd0");
    expect(palette.roomPalette("light").lookalike).toBe("#875400");
    expect(palette.roomPalette("dark").lookalike).toBe("#f2a93b");
  });

  it("keeps the shipped dark film under the dark class only, so no class at all is Linen", () => {
    expect(room.FILM_STYLE).toMatch(/html\.dark \[data-film-room\] \{\s*--bg: #0b0b0c;/);
    expect(room.FILM_STYLE).not.toContain(":not(.light)");
    const html = render(createElement(LandingStory, { data: day(), variant: "chapter" as const }));
    expect(html).toContain('data-film="still"');
    expect(html).not.toContain('class="story"');
  });
});

describe("the words", () => {
  const sources = (() => {
    const files: string[] = [];
    const walk = (at: string) => {
      if (statSync(at).isDirectory()) {
        readdirSync(at).forEach((entry) => walk(path.join(at, entry)));
      } else {
        files.push(at);
      }
    };
    walk("components/story");
    return files.map((file) => ({ file, text: readFileSync(file, "utf8") }));
  })();

  it("come from the story keys, and nothing reads the retired made and trusted beats", () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/\bt\("(made|trusted)\./);
      expect(text, file).not.toContain('"story.made');
      expect(text, file).not.toContain('"story.trusted');
    }
  });

  it("never say anything in the future tense", () => {
    const said: string[] = [];
    const walk = (node: unknown) => {
      if (typeof node === "string") {
        said.push(node);
      } else if (node !== null && typeof node === "object") {
        Object.values(node).forEach(walk);
      }
    };
    walk(en.story);
    for (const line of said) {
      expect(line).not.toMatch(/\bwill\b|\bsoon\b|\bcoming\b/i);
    }
  });

  it("carry no long dash in the film's files", () => {
    const dash = String.fromCharCode(0x2014);
    for (const { file, text } of sources) {
      expect(text.includes(dash), file).toBe(false);
    }
  });
});
