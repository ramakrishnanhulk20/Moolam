import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider, createTranslator } from "next-intl";
import type { Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "@/messages/en.json";
import type { Art } from "@/components/passport/art";
import type { Attestation, Dispute, Passport } from "@/lib/chain/registry";
import type { LookalikeFacts, MarkSchema } from "@/lib/data/marks";
import type { IndexedAttestation } from "@/components/passport/indexed";

/**
 * The trust mark, the look-alike block, the strength of a claim and the
 * registrant's statements (WO-284a), one invariant per describe block:
 * L4, L5, L6, L21, L25, L30, L31 and L32 of the look-alike threat model.
 *
 * Every read is a stub. What these tests do NOT cover: the hosted index's real
 * answer to the new fields (it serves them only after the push-day redeploy),
 * the verify service's real candidates route, and the network forwarder's real
 * transactions; each is replaced here by the shape its interface promises.
 */

vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace?: string) => createTranslator({ locale: "en", messages: en, namespace }),
  getFormatter: async () => ({
    dateTime: (date: Date) => new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" }).format(date),
  }),
}));

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
}));

const reads = vi.hoisted(() => ({
  record: vi.fn(),
  rows: vi.fn(),
  delivery: vi.fn(),
  schema: vi.fn(),
  lookalikes: vi.fn(),
  art: vi.fn(),
  searched: vi.fn(),
}));

vi.mock("@/lib/chain/registry", async (original) => ({
  ...(await original<typeof import("@/lib/chain/registry")>()),
  heldPassportRecord: reads.record,
}));
vi.mock("@/components/passport/indexed", async (original) => ({
  ...(await original<typeof import("@/components/passport/indexed")>()),
  heldIndexedVerdictRows: reads.rows,
}));
vi.mock("@/lib/chain/reports", () => ({ heldReportDelivery: reads.delivery }));
vi.mock("@/lib/data/marks", async (original) => ({
  ...(await original<typeof import("@/lib/data/marks")>()),
  markSchema: reads.schema,
  heldLookalikeFacts: reads.lookalikes,
}));
vi.mock("@/lib/data/passports", async (original) => ({
  ...(await original<typeof import("@/lib/data/passports")>()),
  heldArt: reads.art,
}));
vi.mock("@/components/mark/search", () => ({ heldSearchedEarlier: reads.searched }));

const { issueMark, MARK_STATES } = await import("@/components/mark/mark");
const { MARK_PHASH_LIMIT } = await import("@/components/mark/rule");
const { networkVerdicts, passportMarkFacts } = await import("@/components/mark/read");
const { markCopy } = await import("@/components/mark/copy");
const { MarkBand } = await import("@/components/mark/MarkBand");
const { claimCopy, ClaimLines } = await import("@/components/mark/claim");
const { claimOf, seenEarlierLink } = await import("@/components/mark/strength");
const { plateMarkState } = await import("@/components/mark/plate");
const { statementsOf, SWORN_TEXT } = await import("@/components/passport/art");
const { addresses } = await import("@/lib/chain/client");
const marks = await import("@/lib/data/marks");

const ID = `0x${"7c".repeat(32)}` as Hex;
const EARLIER = `0x${"e1".repeat(32)}` as Hex;
const LATER = `0x${"1a".repeat(32)}` as Hex;
const CREATOR = "0x551610a063BcAd79e6bd25dc55cEe92Ba3FD960a" as Hex;
const PHASH = 0xf0f0f0f0f0f0f0f0n;
const NETWORK_TX = `0x${"aa".repeat(32)}` as Hex;
const SIMULATOR_TX = `0x${"bb".repeat(32)}` as Hex;
const REGISTERED = 1_790_000_000;

const passport: Passport = {
  id: ID,
  exactHash: ID,
  parentId: `0x${"0".repeat(64)}` as Hex,
  creator: CREATOR,
  generatorAgentId: 0n,
  phash: PHASH,
  blockhash256: `0x${"11".repeat(32)}` as Hex,
  manifestHash: `0x${"0".repeat(64)}` as Hex,
  kind: 1,
  fingerprintVersion: 1,
  registeredAt: BigInt(REGISTERED),
  disputed: false,
  metadataURI: "ipfs://bafkreidocument",
};

const art: Art = {
  title: "Monsoon Fishing Nets Drying",
  imageUrl: "https://gateway.example/ipfs/bafkreipicture",
  thumbnailUrl: "https://gateway.example/ipfs/bafkreithumb",
  statements: { sworn: true },
  missing: false,
};

/** A verdict on chain. `recomputed` equal to the stored pHash is 0 bits apart. */
function verdict(over: Partial<Attestation> = {}): Attestation {
  return {
    receiver: addresses.receiver,
    matched: true,
    distance: 0,
    recomputed: `0x${PHASH.toString(16).padStart(64, "0")}` as Hex,
    at: BigInt(REGISTERED + 600),
    ...over,
  };
}

function row(attestation: Attestation, txHash: Hex, network?: boolean): IndexedAttestation {
  return {
    txHash,
    receiver: attestation.receiver,
    matched: attestation.matched,
    distance: attestation.distance,
    at: attestation.at,
    ...(network === undefined ? {} : { network }),
  };
}

function bundle(attestations: Attestation[], dispute: Dispute | null = null) {
  return { passport, attestations, edits: [], owner: CREATOR, dispute, hasPasskey: true };
}

const NEW_INDEX: MarkSchema = { network: true, lookalikes: true, networkCount: true };
const OLD_INDEX: MarkSchema = { network: false, lookalikes: false, networkCount: false };

function lookalikeRows(own: Partial<Extract<LookalikeFacts, { kind: "rows" }>["own"]> | null, later = 0): LookalikeFacts {
  return {
    kind: "rows",
    own:
      own === null
        ? null
        : {
            earlier: EARLIER,
            phashDistance: 2,
            blockhashDistance: 6,
            earlierSealed: false,
            executedAt: REGISTERED + 900,
            txHash: NETWORK_TX,
            network: true,
            valid: true,
            earlierPassport: { id: EARLIER, registeredAt: REGISTERED - 86_400 * 3, metadataURI: "ipfs://bafkreiearlier" },
            ...own,
          },
    laterCount: later,
    later: later === 0 ? null : { id: LATER, registeredAt: REGISTERED + 86_400, metadataURI: "ipfs://bafkreilater" },
  };
}

function render(node: ReactElement): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{ locale: string; messages: unknown; timeZone: string }>;
  return renderToStaticMarkup(createElement(Provider, { locale: "en", messages: en, timeZone: "UTC" }, node));
}

const shown = (line: string): string => line.replace(/'/g, "&#x27;");

beforeEach(() => {
  reads.record.mockResolvedValue(bundle([]));
  reads.rows.mockResolvedValue([]);
  reads.delivery.mockResolvedValue("unknown");
  reads.schema.mockResolvedValue(NEW_INDEX);
  reads.lookalikes.mockResolvedValue(lookalikeRows(null));
  reads.art.mockImplementation(async (uri: string) => ({
    title: uri.includes("earlier") ? "The first nets" : uri.includes("later") ? "A later copy" : undefined,
    missing: false,
  }));
  reads.searched.mockResolvedValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("L30: one function issues the mark, worst first", () => {
  const base = {
    dispute: "none" as const,
    verdicts: [] as { network: boolean; matched: boolean; phashBits: number; at: number }[],
    lookalike: { read: true as const, record: null },
    picture: "public" as const,
    phashLimit: MARK_PHASH_LIMIT,
  };
  const network = (matched: boolean, at = 10, phashBits = 0) => ({ network: true, matched, phashBits, at });
  const found = { network: true, valid: true, earlier: EARLIER as string, executedAt: 5 };

  it("names the eight marks in the order the design ranks them", () => {
    expect(MARK_STATES).toEqual(["upheld", "mismatch", "lookalike", "challenged", "waiting", "checked", "sealed", "nothing"]);
  });

  it("gives each state when nothing worse holds, and the worse one whenever two hold at once", () => {
    expect(issueMark({ ...base, dispute: "upheld", verdicts: [network(false)], lookalike: { read: true, record: found } }).state).toBe("upheld");
    expect(issueMark({ ...base, dispute: "open", verdicts: [network(false)], lookalike: { read: true, record: found } }).state).toBe("mismatch");
    expect(issueMark({ ...base, dispute: "open", verdicts: [network(true)], lookalike: { read: true, record: found } }).state).toBe("lookalike");
    expect(issueMark({ ...base, dispute: "open", verdicts: [network(true)] }).state).toBe("challenged");
    expect(issueMark({ ...base }).state).toBe("waiting");
    expect(issueMark({ ...base, verdicts: [network(true)] }).state).toBe("checked");
    expect(issueMark({ ...base, picture: "sealed" }).state).toBe("sealed");
    expect(issueMark({ ...base, picture: "none" }).state).toBe("nothing");
    expect(issueMark({ ...base, dispute: "rejected", verdicts: [network(true)] }).state).toBe("checked");
  });

  it("never lets a simulator verdict light Checked by Chainlink or Does not match", () => {
    const simulator = [{ network: false, matched: true, phashBits: 0, at: 9 }];
    expect(issueMark({ ...base, verdicts: simulator }).state).toBe("waiting");
    expect(issueMark({ ...base, verdicts: [{ ...simulator[0], matched: false }] }).state).toBe("waiting");
  });

  it("follows the newest network verdict and calls a layout-only miss a second print", () => {
    expect(issueMark({ ...base, verdicts: [network(false, 1), network(true, 2)] }).state).toBe("checked");
    const layout = issueMark({ ...base, verdicts: [network(false, 3, MARK_PHASH_LIMIT)] });
    expect(layout).toMatchObject({ state: "mismatch", secondPrint: true });
    expect(issueMark({ ...base, verdicts: [network(false, 3, MARK_PHASH_LIMIT + 1)] })).toMatchObject({ secondPrint: false });
  });

  it("keeps the site's number the same as the shared look-alike rule's", () => {
    const rule = readFileSync(fileURLToPath(new URL("../../verifier/src/lookalike-rule.ts", import.meta.url)), "utf8");
    expect(rule).toContain(`export const LOOKALIKE_PHASH_BITS = ${MARK_PHASH_LIMIT};`);
  });

  it("keeps the site's mark.ts byte for byte the MCP server's", () => {
    const site = readFileSync(fileURLToPath(new URL("../components/mark/mark.ts", import.meta.url)));
    const server = readFileSync(fileURLToPath(new URL("../../verifier/src/mcp/mark.ts", import.meta.url)));
    expect(site.equals(server)).toBe(true);
  });

  it("draws the same mark on an Explore plate from the index's side of the facts", () => {
    expect(plateMarkState(undefined, "public")).toBeNull();
    const facts = { dispute: "none" as const, verdict: null, earlierFound: false, laterCount: 0 };
    expect(plateMarkState(facts, "public")).toBe("waiting");
    expect(plateMarkState({ ...facts, verdict: { matched: true, distance: 0, at: 1 } }, "public")).toBe("checked");
    expect(plateMarkState({ ...facts, earlierFound: true, verdict: { matched: true, distance: 0, at: 1 } }, "public")).toBe("lookalike");
    expect(plateMarkState({ ...facts, dispute: "upheld" }, "public")).toBe("upheld");
    expect(plateMarkState(facts, null)).toBeNull();
  });
});

describe("L4: only Chainlink's network lights a mark, by the transaction and the index's flag", () => {
  it("takes the index's network flag once it serves one, over what the forwarder would say", async () => {
    const onChain = verdict();
    expect(await networkVerdicts(passport, [onChain], [row(onChain, NETWORK_TX, false)], true)).toEqual([
      expect.objectContaining({ network: false }),
    ]);
    expect(reads.delivery).not.toHaveBeenCalled();
    expect(await networkVerdicts(passport, [onChain], [row(onChain, NETWORK_TX, true)], true)).toEqual([
      expect.objectContaining({ network: true, matched: true, phashBits: 0 }),
    ]);
  });

  it("decides from the report transaction's `to` on an index without the flag", async () => {
    const onChain = verdict();
    reads.delivery.mockImplementation(async (hash: Hex) => (hash === NETWORK_TX ? "network" : "simulation"));
    expect(await networkVerdicts(passport, [onChain], [row(onChain, NETWORK_TX)], false)).toEqual([
      expect.objectContaining({ network: true }),
    ]);
    expect(await networkVerdicts(passport, [onChain], [row(onChain, SIMULATOR_TX)], false)).toEqual([
      expect.objectContaining({ network: false }),
    ]);
  });

  it("never calls a verdict from any other receiver the network's, whatever carried it", async () => {
    const elsewhere = verdict({ receiver: addresses.simulationReceiver });
    reads.delivery.mockResolvedValue("network");
    expect(await networkVerdicts(passport, [elsewhere], [row(elsewhere, NETWORK_TX, true)], true)).toEqual([
      expect.objectContaining({ network: false }),
    ]);
  });

  it("lights no look-alike mark from a record the network did not deliver", async () => {
    reads.lookalikes.mockResolvedValue(lookalikeRows({ network: false }));
    const facts = await passportMarkFacts(passport, art);
    expect(facts.mark.state).toBe("waiting");
    expect(facts.lookalike.kind).not.toBe("found");
  });
});

describe("L5: a look-alike record that failed the index's checks is shown nowhere", () => {
  it("draws no mark and no amber block for an invalid record, even one naming a passport", async () => {
    reads.lookalikes.mockResolvedValue(lookalikeRows({ valid: false }));
    const facts = await passportMarkFacts(passport, art);
    expect(facts.mark.state).toBe("waiting");
    expect(facts.lookalike.kind).toBe("quiet");
    const markup = render(MarkBand({ copy: await markCopy(facts, "en") }));
    expect(markup).not.toContain('data-lookalike="found"');
    expect(markup).not.toContain(shown(en.lookalike.found.heading));
  });

  it("presses Registered after a look-alike and the amber block for a valid network record", async () => {
    reads.record.mockResolvedValue(bundle([verdict()]));
    reads.rows.mockResolvedValue([row(verdict(), NETWORK_TX, true)]);
    reads.lookalikes.mockResolvedValue(lookalikeRows({}));
    const facts = await passportMarkFacts(passport, art);
    expect(facts.mark.state).toBe("lookalike");
    expect(facts.lookalike).toMatchObject({ kind: "found", earlier: { id: EARLIER, title: "The first nets" }, bits: 2 });
    const markup = render(MarkBand({ copy: await markCopy(facts, "en") }));
    expect(markup).toContain('data-mark-stamp="lookalike"');
    expect(markup).toContain('data-lookalike="found"');
    expect(markup).toContain(`href="/passport/${EARLIER}"`);
    expect(markup).toContain(shown(en.lookalike.order));
    expect(markup).toContain("text-lookalike");
  });
});

describe("L6: only each passport's newest record counts", () => {
  const fetches: { query: string; variables: Record<string, unknown> }[] = [];

  beforeEach(() => {
    fetches.length = 0;
    vi.stubEnv("NEXT_PUBLIC_ENVIO_GRAPHQL_URL", "http://127.0.0.1:9/graphql");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("asks for the passport's one row by id and counts later ones only by their own newest, network, valid row", async () => {
    vi.resetModules();
    vi.doMock("@/lib/env", async (original) => ({
      ...(await original<typeof import("@/lib/env")>()),
      publicEnv: { ...(await original<typeof import("@/lib/env")>()).publicEnv, envioGraphqlUrl: "http://127.0.0.1:9/graphql" },
    }));
    vi.doUnmock("@/lib/data/marks");
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> };
      fetches.push(body);
      if (body.query.includes("MarkSchema")) {
        const fields = (names: string[]) => ({ fields: names.map((name) => ({ name })) });
        return Response.json({
          data: {
            attestation: fields(["network"]),
            passport: fields(["earlierFound", "laterLookalikeCount"]),
            lookalike: fields(["earlierId", "network", "valid", "executedAt", "phashDistance"]),
          },
        });
      }
      return Response.json({
        data: {
          own: [
            {
              earlierId: `0x${"0".repeat(64)}`,
              phashDistance: 0,
              blockhashDistance: 0,
              earlierSealed: false,
              executedAt: String(REGISTERED + 900),
              txHash: NETWORK_TX,
              network: true,
              valid: true,
              earlier: null,
            },
          ],
          later: [{ passport: { id: LATER, registeredAt: String(REGISTERED + 86_400), metadataURI: "ipfs://bafkreilater" } }],
          Passport: [{ laterLookalikeCount: 2 }],
        },
      });
    });
    const fresh = await import("@/lib/data/marks");
    const facts = await fresh.heldLookalikeFacts(ID);

    const asked = fetches.find((one) => one.query.includes("PassportLookalikes"));
    expect(asked?.variables).toEqual({ id: ID.toLowerCase() });
    expect(asked?.query).toContain("own: Lookalike(where: { id: { _eq: $id } }, limit: 1)");
    expect(asked?.query).toContain("where: { earlierId: { _eq: $id }, network: { _eq: true }, valid: { _eq: true } }");
    expect(asked?.query).toContain("laterLookalikeCount");
    // A zero earlierId is "none", never a match (L5), and the count is the index's own.
    expect(facts).toMatchObject({ kind: "rows", own: { earlier: null, network: true }, laterCount: 2, later: { id: LATER } });
    vi.doUnmock("@/lib/env");
  });

  it("draws the quiet later line on the earlier passport with the index's count", async () => {
    reads.lookalikes.mockResolvedValue(lookalikeRows(null, 3));
    const copy = await markCopy(await passportMarkFacts(passport, art), "en");
    const markup = render(MarkBand({ copy }));
    expect(markup).toContain("data-lookalike-later");
    expect(markup).toContain(`href="/passport/${LATER}"`);
    expect(markup).toContain("3 later passports look the same.");
  });
});

describe("L31: none is not original", () => {
  it("words a network record with no earlier passport exactly as the threat model asks, and never as original", async () => {
    reads.lookalikes.mockResolvedValue(lookalikeRows({ earlier: null, earlierPassport: null }));
    const facts = await passportMarkFacts(passport, art);
    expect(facts.lookalike.kind).toBe("none");
    expect(facts.mark.state).toBe("waiting");
    const markup = render(MarkBand({ copy: await markCopy(facts, "en") }));
    expect(en.lookalike.none).toBe("Chainlink found no earlier look-alike among the candidates Moolam's search proposed.");
    expect(markup).toContain(shown(en.lookalike.none));
    expect(markup.toLowerCase()).not.toContain("original");
  });

  it("keeps Moolam's own search grey and unconfirmed until Chainlink writes a record", async () => {
    reads.searched.mockResolvedValue({ id: EARLIER, registeredAt: REGISTERED - 60, metadataURI: "ipfs://bafkreiearlier" });
    const facts = await passportMarkFacts(passport, art);
    expect(facts.mark.state).toBe("waiting");
    expect(facts.lookalike.kind).toBe("searching");
    const markup = render(MarkBand({ copy: await markCopy(facts, "en") }));
    expect(markup).toContain('data-lookalike="searching"');
    expect(markup).not.toContain("text-lookalike");
    expect(markup).toContain(shown(en.lookalike.searching.heading));
  });
});

describe("L32: every mark is a read that succeeded, and a failed read is said", () => {
  it("says the mark could not be read when the registry did not answer, and presses no stamp", async () => {
    reads.record.mockRejectedValue(new Error("rpc down"));
    const facts = await passportMarkFacts(passport, art);
    expect(facts.mark.state).toBe("unread");
    const markup = render(MarkBand({ copy: await markCopy(facts, "en") }));
    expect(markup).toContain(shown(en.mark.unread));
    expect(markup).not.toContain("data-mark-stamp");
  });

  it("says so when the index serves the look-alike rows and did not answer", async () => {
    reads.lookalikes.mockResolvedValue({ kind: "failed" });
    expect((await passportMarkFacts(passport, art)).mark.state).toBe("unread");
  });

  it("says so when a verdict on the network receiver cannot be placed, rather than calling it waiting", async () => {
    reads.record.mockResolvedValue(bundle([verdict()]));
    reads.rows.mockResolvedValue(null);
    expect((await passportMarkFacts(passport, art)).mark.state).toBe("unread");
  });

  it("still marks an upheld challenge when everything else failed, since nothing outranks it", async () => {
    reads.record.mockResolvedValue({ ...bundle([verdict()]), passport: { ...passport, disputed: true } });
    reads.rows.mockResolvedValue(null);
    reads.lookalikes.mockResolvedValue({ kind: "failed" });
    expect((await passportMarkFacts({ ...passport, disputed: true }, art)).mark.state).toBe("upheld");
  });

  it("treats an index from before the redeploy as not available yet: no error, the mark from the transaction", async () => {
    reads.schema.mockResolvedValue(OLD_INDEX);
    reads.lookalikes.mockResolvedValue({ kind: "absent" });
    reads.record.mockResolvedValue(bundle([verdict()]));
    reads.rows.mockResolvedValue([row(verdict(), NETWORK_TX)]);
    reads.delivery.mockResolvedValue("network");
    const facts = await passportMarkFacts(passport, art);
    expect(facts.mark.state).toBe("checked");
    expect(facts.lookalike.kind).toBe("quiet");
    const markup = render(MarkBand({ copy: await markCopy(facts, "en") }));
    expect(markup).toContain('data-mark-stamp="checked"');
    expect(markup).not.toContain(shown(en.mark.unread));
  });

  it("says unread for a document no gateway handed over, rather than waiting", async () => {
    expect((await passportMarkFacts(passport, { missing: true })).mark.state).toBe("unread");
  });

  it("asks the old index only for the fields it has", async () => {
    expect(marks.NO_MARK_FIELDS).toEqual({ network: false, lookalikes: false, networkCount: false });
    const source = readFileSync(fileURLToPath(new URL("../lib/data/passports.ts", import.meta.url)), "utf8");
    expect(source).toContain('filter.marks === true');
  });
});

describe("L21: the sworn line, seenEarlier and seenOnline are the registrant's own words", () => {
  const claim = async (statements: Art["statements"]) =>
    render(ClaimLines({ copy: await claimCopy({ passport, art: { ...art, statements }, platform: null, now: REGISTERED }) }));

  it("links seenEarlier only when it is a passport id, and draws anything else as text", async () => {
    expect(seenEarlierLink(EARLIER)).toBe(EARLIER);
    expect(seenEarlierLink("https://evil.example/0x")).toBeNull();
    expect(seenEarlierLink(`${EARLIER}x`)).toBeNull();

    const linked = await claim({ sworn: true, seenEarlier: EARLIER });
    expect(linked).toContain(`href="/passport/${EARLIER}"`);

    const text = await claim({ sworn: true, seenEarlier: "https://evil.example/page" });
    expect(text).toContain("https://evil.example/page");
    expect(text).not.toContain('href="https://evil.example');
  });

  it("lists the web pages as text, never as links, with the count as stored", async () => {
    const markup = await claim({ sworn: true, seenOnline: { count: 12, pages: ["https://news.example/a", "http://blog.example/b"] } });
    expect(markup).toContain("data-claim-seen-online");
    expect(markup).toContain("https://news.example/a");
    expect(markup).not.toContain('href="https://news.example');
    expect(markup).not.toContain('href="http://blog.example');
    expect(markup).toContain("12 pages");
    expect(markup).toContain("10 more pages counted, not listed.");
  });

  it("draws the sworn line in the registrant's voice only when the document carries it word for word", async () => {
    expect(statementsOf({ sworn: { text: SWORN_TEXT, version: 1 } }).sworn).toBe(true);
    expect(statementsOf({ sworn: { text: "I made this.", version: 1 } }).sworn).toBe(false);
    const markup = await claim({ sworn: true });
    expect(markup).toContain(shown(en.story.sealed.readoutSworn));
  });

  it("cuts and flattens what a document written straight on chain could carry", () => {
    const read = statementsOf({
      seenEarlier: `x‮${"y".repeat(500)}`,
      seenOnline: { count: 3, pages: ["https://a.example/1\nhttps://b.example", 7, ""] },
      platformStatement: "  line one\u0000line two  ",
    });
    expect(read.seenEarlier?.length).toBe(80);
    expect(read.seenEarlier).not.toContain("‮");
    expect(read.seenOnline).toEqual({ count: 3, pages: ["https://a.example/1 https://b.example"] });
    expect(read.platformStatement).toBe("line one line two");
    expect(statementsOf({ seenOnline: { count: 0, pages: ["https://a.example"] } }).seenOnline).toBeUndefined();
  });
});

describe("L25: a registration from outside the studio is labelled, never clean", () => {
  const strength = async (statements: Art["statements"], generatorAgentId = 0n) =>
    render(
      ClaimLines({
        copy: await claimCopy({
          passport: { ...passport, generatorAgentId },
          art: { ...art, statements },
          platform: null,
          now: REGISTERED,
        }),
      }),
    );

  it("says outside the studio for a document with no sworn line and no platform statement", async () => {
    const markup = await strength({ sworn: false });
    expect(markup).toContain('data-claim-origin="outside"');
    expect(markup).toContain(shown(en.claim.outside));
  });

  it("says nothing of the kind for a sworn document, a platform's statement, or a document nobody could read", async () => {
    expect(await strength({ sworn: true })).not.toContain("data-claim-origin");
    expect(await strength({ sworn: false, platformStatement: "Drawn on Dreamloom by its user." })).not.toContain("data-claim-origin");
    expect(await strength(undefined)).not.toContain("data-claim-origin");
  });

  it("names the strength of the claim: studio, a listed platform, or the registrant's own until thirty days pass", () => {
    const at = { generatorAgentId: 0n, studioAgentId: 10248n, platform: null, creator: CREATOR, registeredAt: REGISTERED, now: REGISTERED };
    expect(claimOf({ ...at, generatorAgentId: 10248n }).key).toBe("studio");
    expect(claimOf({ ...at, platform: { status: "kit", name: "Dreamloom" } })).toEqual({ key: "platform", platform: "Dreamloom" });
    expect(claimOf({ ...at, platform: { status: "outsideKit", name: "Dreamloom" } }).key).toBe("self");
    expect(claimOf({ ...at, now: REGISTERED + 30 * 86_400 }).key).toBe("self");
    expect(claimOf({ ...at, now: REGISTERED + 30 * 86_400 + 1 }).key).toBe("selfLater");
  });
});
