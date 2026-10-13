import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse, TYPE, type MessageFormatElement } from "@formatjs/icu-messageformat-parser";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import en from "@/messages/en.json";
import type { Art } from "@/components/passport/art";
import type { Attestation } from "@/lib/chain/registry";

/**
 * The judge's walk on words (WO-293b, rows 4, 5, 6, 9, 11, 12, 15, 23 and 25
 * of the UI audit of 2026-10-01): a run in Chainlink's simulator is a test run
 * on every surface and only a network verdict is a check; the claim's origin
 * says who wrote the document; the challenge rules read without an account; and
 * the small wording slips are gone in all ten languages.
 *
 * Every read is a stub. What these tests do NOT cover: the hosted index's real
 * GlobalStats row (it serves networkAttestations only after the push-day
 * rebuild), the forwarder of a real report transaction, and the browser's
 * sign-in flow; each is replaced by the shape its interface promises.
 */

const reads = vi.hoisted(() => ({
  record: vi.fn(),
  rows: vi.fn(),
  delivery: vi.fn(),
  source: vi.fn(() => "envio" as const),
}));

vi.mock("next/cache", () => ({ unstable_cache: <T,>(read: T) => read }));
vi.mock("@/lib/data/source", () => ({ activeSource: reads.source, envioUrl: () => "https://index.example/v1/graphql" }));
vi.mock("@/lib/chain/registry", async (original) => ({
  ...(await original<typeof import("@/lib/chain/registry")>()),
  heldPassportRecord: reads.record,
}));
vi.mock("@/components/passport/indexed", async (original) => ({
  ...(await original<typeof import("@/components/passport/indexed")>()),
  heldIndexedVerdictRows: reads.rows,
}));
vi.mock("@/lib/chain/reports", () => ({ heldReportDelivery: reads.delivery }));

const { withoutDoubleStop, endsSentence } = await import("@/lib/i18n/sentence");
const { claimOrigin, claimOf } = await import("@/components/mark/strength");
const { markStanding } = await import("@/components/passport/labels");
const { chainlinkRecheck } = await import("@/components/home/finding");
const { topFacts } = await import("@/components/passport/top-facts");
const { heldNetworkCheckCount } = await import("@/lib/data/marks");
const { newestVerdictStanding } = await import("@/lib/passport/standing");
const { addresses } = await import("@/lib/chain/client");

const root = fileURLToPath(new URL("..", import.meta.url));
const LANGS = ["de", "es", "fr", "hi", "ja", "ko", "pt", "ta", "zh"] as const;
const EM_DASH = String.fromCharCode(8212);

afterEach(() => {
  vi.unstubAllGlobals();
  reads.record.mockReset();
  reads.rows.mockReset();
  reads.delivery.mockReset();
  reads.source.mockReset().mockReturnValue("envio");
});

describe("row 23: a title that ends a sentence takes no second stop from the template", () => {
  it("drops the template's stop after a title ending in a stop, in Latin and CJK scripts", () => {
    const title = "God of War Kratos Fights against Egyptian gods.";
    expect(withoutDoubleStop(`Yes. This is the same picture as ${title}.`, title)).toBe(`Yes. This is the same picture as ${title}`);
    expect(withoutDoubleStop(`Why?.`, "Why?")).toBe("Why?");
    expect(withoutDoubleStop(`${title}。`, title)).toBe(title);
    expect(endsSentence("gods.")).toBe(true);
    expect(endsSentence("gods")).toBe(false);
    expect(endsSentence("")).toBe(false);
  });

  it("leaves a sentence alone when the title ends no sentence, stands mid-sentence, or is not at the end", () => {
    expect(withoutDoubleStop("Yes. This is the same picture as Monsoon.", "Monsoon")).toBe("Yes. This is the same picture as Monsoon.");
    expect(withoutDoubleStop("はい。これは gods. と同じ画像です。", "gods.")).toBe("はい。これは gods. と同じ画像です。");
    expect(withoutDoubleStop("", "gods.")).toBe("");
  });
});

describe("row 4: the shared count of Chainlink network checks", () => {
  function index(fields: string[], count: number | "fail"): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { query: string };
        if (body.query.includes("MarkSchema")) {
          return Response.json({
            data: {
              attestation: { fields: [{ name: "network" }] },
              passport: { fields: [] },
              lookalike: null,
              stats: { fields: fields.map((name) => ({ name })) },
            },
          });
        }
        if (body.query.includes("NetworkChecks")) {
          return count === "fail" ? new Response("down", { status: 500 }) : Response.json({ data: { GlobalStats: [{ networkAttestations: count }] } });
        }
        throw new Error(`unexpected query ${body.query}`);
      }),
    );
  }

  it("gives no number on an index without the field, and never sends the count query", async () => {
    index(["passports", "attestations"], 33);
    expect(await heldNetworkCheckCount()).toBeNull();
    const queries = (fetch as unknown as { mock: { calls: [unknown, RequestInit][] } }).mock.calls.map(([, init]) => String(init.body));
    expect(queries.some((query) => query.includes("NetworkChecks"))).toBe(false);
  });

  it("gives the index's own count once it serves the field, and null when that read fails", async () => {
    index(["passports", "attestations", "networkAttestations"], 33);
    expect(await heldNetworkCheckCount()).toBe(33);
    index(["networkAttestations"], "fail");
    expect(await heldNetworkCheckCount()).toBeNull();
  });

  it("gives no number without an index at all, and asks nothing", async () => {
    reads.source.mockReturnValue("chain");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({})));
    expect(await heldNetworkCheckCount()).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});

const ID = `0x${"7c".repeat(32)}` as Hex;
const PHASH = 0x6ccf137087789a25n;
const SAME = `0x${PHASH.toString(16).padStart(64, "0")}` as Hex;
const TX = `0x${"a1".repeat(32)}` as Hex;

function attestation(receiver: Hex, at: bigint, matched = true): Attestation {
  return { receiver, matched, distance: matched ? 0 : 3, recomputed: SAME, at };
}

describe("row 4: where the newest verdict came from, for the verify card", () => {
  const passport = { id: ID, phash: PHASH };

  /** An index from before the push-day rebuild: it serves none of the mark's fields. */
  function oldIndex(): void {
    reads.rows.mockResolvedValue([]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: { attestation: { fields: [] }, passport: { fields: [] }, lookalike: null, stats: null } })),
    );
  }

  it("is none without a verdict, a test run from a simulation receiver, and the network's when the forwarder was", async () => {
    oldIndex();
    reads.record.mockResolvedValue({ passport, attestations: [] });
    expect(await newestVerdictStanding(ID)).toBe("none");

    reads.record.mockResolvedValue({ passport, attestations: [attestation(addresses.simulationReceiver, 1_790_400_000n)] });
    expect(await newestVerdictStanding(ID)).toBe("testRun");

    const row = attestation(addresses.receiver, 1_790_500_000n);
    reads.record.mockResolvedValue({ passport, attestations: [attestation(addresses.simulationReceiver, 1_790_400_000n), row] });
    reads.rows.mockResolvedValue([{ txHash: TX, receiver: row.receiver, matched: true, distance: 0, at: row.at }]);
    reads.delivery.mockResolvedValue("network");
    expect(await newestVerdictStanding(ID)).toBe("network");
    reads.delivery.mockResolvedValue("simulation");
    expect(await newestVerdictStanding(ID)).toBe("testRun");
  });

  it("is unread for an id that is not a passport, a record the registry lacks, and rows the index would not give", async () => {
    oldIndex();
    expect(await newestVerdictStanding("0x1234")).toBe("unread");
    reads.record.mockResolvedValue({ passport: null, attestations: [] });
    expect(await newestVerdictStanding(ID)).toBe("unread");
    reads.record.mockResolvedValue({ passport, attestations: [attestation(addresses.receiver, 1_790_500_000n)] });
    reads.rows.mockRejectedValue(new Error("index down"));
    expect(await newestVerdictStanding(ID)).toBe("unread");
  });
});

describe("row 4: the home first screen's run and the facts strip name the simulator", () => {
  const rows = [{ receiver: addresses.receiver, matched: true, distance: 0, at: 1_789_380_000n }];

  it("carries the mark's reading into the first screen's recheck, and null when there was none", () => {
    expect(chainlinkRecheck(rows, [addresses.receiver], [{ at: 1_789_380_000, network: false }])).toEqual({
      matched: true,
      distance: 0,
      at: 1_789_380_000,
      network: false,
    });
    expect(chainlinkRecheck(rows, [addresses.receiver], null)?.network).toBeNull();
    expect(chainlinkRecheck(rows, [addresses.receiver], [])?.network).toBeNull();
  });

  const say = {
    kind: () => "Generated",
    agentNumber: (id: string) => `Agent ${id}`,
    cardNamed: (agent: string) => agent,
    statement: () => "closed",
    bits: (count: number) => `${count} of 64 bits`,
    privateRecheck: en.passport.attestations.private.badge,
    testRun: en.mark.simulator.word,
    privateTestRun: en.passport.attestations.private.testRun,
    sealed: en.passport.sealed.label,
    date: () => "Sep 14, 2026",
    words: en.passport.facts,
  };
  const input = {
    creator: `0x${"85".repeat(20)}` as Hex,
    agentId: 10249n,
    agentName: null,
    kind: 0,
    consent: null,
    attestations: [attestation(addresses.receiver, 1_789_380_000n)],
    phash: PHASH,
    sealed: false,
    privateRecheck: false,
  };

  it("says Test run in the quiet ink for a simulator run, Chainlink for the network's, and unread when the mark could not read it", () => {
    const [, , , testRun] = topFacts({ ...input, verdicts: [{ at: 1_789_380_000, network: false }] }, say);
    expect(testRun.value).toBe(`${en.mark.simulator.word}, Sep 14, 2026, 0 of 64 bits`);
    expect(testRun.tone).toBe("faint");

    const [, , , checked] = topFacts({ ...input, verdicts: [{ at: 1_789_380_000, network: true }] }, say);
    expect(checked.value).toBe("Chainlink, Sep 14, 2026, 0 of 64 bits");
    expect(checked.tone).toBe("verified");

    const [, , , unread] = topFacts({ ...input, verdicts: null }, say);
    expect(unread.value).toBe(en.passport.facts.unread);
    expect(unread.unread).toBe(true);
    expect(topFacts(input, say)[3].unread).toBe(true);
  });

  it("gives the record chip the mark's word: only a network verdict says checked, and a disputed page stays disputed", () => {
    expect(markStanding("verified", "waiting")).toBe("unverified");
    expect(markStanding("verified", "checked")).toBe("verified");
    expect(markStanding("verified", "mismatch")).toBe("mismatched");
    expect(markStanding("verified", "unread")).toBe("unread");
    expect(markStanding("disputed", "checked")).toBe("disputed");
    expect(markStanding("unverified", "upheld")).toBe("disputed");
    expect(markStanding("unverified", "sealed")).toBe("unverified");
  });
});

describe("rows 5 and 9: the origin line under the claim rests on chain facts", () => {
  const pinned = "ipfs://bafkreidocument";
  const SINCE = 1_790_000_000;
  const BEFORE = SINCE - 86_400;
  const AFTER = SINCE + 86_400;
  /** A document read with no statement, as a raw chain write copying the service's shape would give. */
  const copied: Pick<Art, "statements"> = { statements: { sworn: false } };

  it("reads a raw write that copies the document format as outside after the sworn line went live, and before it as before", () => {
    expect(claimOrigin({ registeredAt: AFTER, metadataURI: pinned, art: copied, platform: null, swornSince: SINCE })).toBe("outside");
    expect(claimOrigin({ registeredAt: BEFORE, metadataURI: pinned, art: copied, platform: null, swornSince: SINCE })).toBe("beforeSworn");
    // A data: document is an address the service never pins: outside after the line, before it before.
    const raw = { metadataURI: 'data:application/json,{"name":"signed.jpg"}', art: { missing: true } as Art, platform: null, swornSince: SINCE };
    expect(claimOrigin({ ...raw, registeredAt: AFTER })).toBe("outside");
    expect(claimOrigin({ ...raw, registeredAt: BEFORE })).toBe("beforeSworn");
  });

  it("reads a listed platform's kit passport as kit either way, and a statement as none of the lines", () => {
    expect(claimOrigin({ registeredAt: AFTER, metadataURI: pinned, art: copied, platform: { status: "kit" }, swornSince: SINCE })).toBe("kit");
    expect(claimOrigin({ registeredAt: BEFORE, metadataURI: pinned, art: copied, platform: { status: "kit" }, swornSince: SINCE })).toBe("kit");
    expect(claimOrigin({ registeredAt: AFTER, metadataURI: pinned, art: { statements: { sworn: true } }, platform: null, swornSince: SINCE })).toBe("stated");
    expect(
      claimOrigin({ registeredAt: BEFORE, metadataURI: pinned, art: { statements: { sworn: false, platformStatement: "Drawn on Dreamloom." } }, platform: { status: "kit" }, swornSince: SINCE }),
    ).toBe("stated");
  });

  it("counts a platform's statement only from a creator Moolam's list names, since any registrant can write the field", () => {
    const statement: Pick<Art, "statements"> = { statements: { sworn: false, platformStatement: "Drawn on Dreamloom." } };
    const listed = { registeredAt: AFTER, metadataURI: pinned, art: statement, swornSince: SINCE };
    expect(claimOrigin({ ...listed, platform: { status: "kit" } })).toBe("stated");
    expect(claimOrigin({ ...listed, platform: { status: "outsideKit" } })).toBe("stated");
    expect(claimOrigin({ ...listed, platform: null })).toBe("outside");
    expect(claimOrigin({ ...listed, platform: null, registeredAt: BEFORE })).toBe("beforeSworn");
    // The sworn line is not gated by the creator: it is the registrant's own words by design.
    expect(claimOrigin({ ...listed, platform: null, art: { statements: { sworn: true } } })).toBe("stated");
  });

  it("reads every passport without a statement as before while SWORN_SINCE is null, and says nothing for an unread pinned document after it", () => {
    expect(claimOrigin({ registeredAt: AFTER, metadataURI: pinned, art: copied, platform: null, swornSince: null })).toBe("beforeSworn");
    expect(claimOrigin({ registeredAt: AFTER, metadataURI: pinned, art: copied, platform: null })).toBe("beforeSworn");
    expect(claimOrigin({ registeredAt: AFTER, metadataURI: pinned, art: { statements: undefined }, platform: null, swornSince: SINCE })).toBeNull();
    expect(claimOrigin({ registeredAt: BEFORE, metadataURI: pinned, art: { statements: undefined }, platform: null, swornSince: SINCE })).toBe("beforeSworn");
    expect(en.claim.beforeSworn).not.toContain("Moolam");
  });

  it("names the person and the platform for a co-signed picture, where the record used to say uploaded by", () => {
    const person = `0xc3${"71".repeat(19)}` as Hex;
    const at = { generatorAgentId: 10273n, studioAgentId: 10248n, platform: null, creator: person, registeredAt: 1_790_772_994, now: 1_790_772_994 };
    expect(claimOf({ ...at, credit: { case: "cosigned", platform: "Dreamloom", imaginedBy: person } })).toEqual({
      key: "cosigned",
      platform: "Dreamloom",
      person,
      date: 1_790_772_994,
    });
    expect(claimOf({ ...at, credit: { case: "held", platform: "Dreamloom", imaginedBy: null } }).key).toBe("self");
    expect(claimOf({ ...at, credit: null }).key).toBe("self");
    expect(en.claim.cosigned).toContain("{person}");
    expect(en.claim.cosigned).toContain("{platform}");
  });
});

describe("rows 6, 11, 12, 15 and 25: the words, in all ten files", () => {
  const CHANGED = [
    "home.first.recheckOn",
    "home.first.testRunOn",
    "story.close.attestations",
    "story.stated.readout",
    "verify.recheck.count",
    "verify.recheck.matched",
    "verify.recheck.mismatched",
    "verify.recheck.network",
    "verify.recheck.testRun",
    "passport.attestations.byTestRun",
    "passport.attestations.private.testRun",
    "recheck.testRunOn",
    "mark.states.sealed.lineTestRun",
    "claim.beforeSworn",
    "claim.kitNoStatement",
    "claim.cosigned",
    "business.live.nowShipped",
    "passport.dispute.flag.signedOut",
    "passport.dispute.flag.signInToChallenge",
    "resolve.creditSignedOut",
  ];

  type Tree = { [key: string]: string | Tree };
  const files = Object.fromEntries(
    ["en", ...LANGS].map((lang) => [lang, JSON.parse(readFileSync(`${root}messages/${lang}.json`, "utf8")) as Tree]),
  );
  const at = (tree: Tree, key: string): string => key.split(".").reduce<Tree | string>((node, part) => (node as Tree)[part], tree) as string;

  function shape(message: string): { args: string; tags: string } {
    const args = new Set<string>();
    const tags = new Set<string>();
    const walk = (elements: MessageFormatElement[]): void => {
      for (const element of elements) {
        if (element.type === TYPE.argument || element.type === TYPE.number || element.type === TYPE.date || element.type === TYPE.time) {
          args.add(element.value);
        } else if (element.type === TYPE.plural || element.type === TYPE.select) {
          args.add(element.value);
          for (const option of Object.values(element.options)) {
            walk(option.value);
          }
        } else if (element.type === TYPE.tag) {
          tags.add(element.value);
          walk(element.children);
        }
      }
    };
    walk(parse(message));
    return { args: [...args].sort().join(","), tags: [...tags].sort().join(",") };
  }

  it("carries every changed key, parsing as ICU with the English arguments and tags, in its own words and with no em-dash", () => {
    for (const key of CHANGED) {
      const english = at(files.en, key);
      expect(typeof english, key).toBe("string");
      const want = shape(english);
      for (const lang of LANGS) {
        const line = at(files[lang], key);
        expect(typeof line, `${lang} ${key}`).toBe("string");
        expect(line, `${lang} ${key}`).not.toBe(english);
        expect(line.includes(EM_DASH), `${lang} ${key}`).toBe(false);
        expect(shape(line), `${lang} ${key}`).toEqual(want);
      }
    }
  });

  it("finishes the terms readout and names the simulator where a check was claimed", () => {
    expect(en.story.stated.readout).toBe("Terms written on Monad {written}, and in force since then.");
    expect(at(files.fr, "story.stated.readout")).not.toMatch(/depuis\.$/);
    expect(en.story.close.attestations).toContain("network");
    expect(en.verify.recheck.testRun).toContain("test run");
    expect(en.verify.recheck.matched).not.toContain("Checked by");
    expect(en.resolve.creditSignedOut).toBe("Sign in to see what the registry owes you.");
    expect(en.passport.dispute.flag.signInToChallenge).toBe("Sign in to challenge");
    expect(en.business.live.nowShipped).toContain("email");
  });
});
