import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement, isValidElement, type FunctionComponent, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";
import type { ExploreSearch } from "@/components/explore/query";
import type { ExplorePlate } from "@/components/explore/sort";

/**
 * Explore's opening, its search and its empty sheet (WO-215).
 *
 * Four things are held here, all against a fixture index and a fixture
 * gateway, never the live ones: from 1024 px the page opens compact with the
 * pictures right under the chips; the search box finds a picture by its title
 * as well as by its id, with one index query per page; a sheet that matched
 * nothing says what narrowed it and offers the way back; and a plate whose
 * record did not arrive stays among the pictures.
 */

const INDEX_URL = "https://index.example/v1/graphql";

vi.mock("next/cache", () => ({
  unstable_cache: <T extends (...args: never[]) => unknown>(read: T) => read,
  revalidateTag: vi.fn(),
}));

vi.mock("next/server", async (real) => ({
  ...(await real<typeof import("next/server")>()),
  connection: vi.fn(),
}));

vi.mock("@/lib/data/lineage", async (real) => ({
  ...(await real<typeof import("@/lib/data/lineage")>()),
  disputedReach: async () => ({ ids: [] }),
}));

vi.mock("@/lib/i18n/routing", () => ({
  Link: ({ href, children, ...rest }: { href: string; children?: unknown; prefetch?: boolean }) => {
    const attributes: Record<string, unknown> = { ...rest };
    delete attributes.prefetch;
    return createElement("a", { href, ...attributes }, children as never);
  },
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: unknown; prefetch?: boolean }) => {
    const attributes: Record<string, unknown> = { ...rest };
    delete attributes.prefetch;
    return createElement("a", { href, ...attributes }, children as never);
  },
  useLinkStatus: () => ({ pending: false }),
}));

vi.mock("@/components/passport/Picture", () => ({
  Picture: () => createElement("span", { "data-picture": "true" }),
}));

vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  const messages = (await import("@/messages/en.json")).default;
  return {
    getTranslations: async (arg?: string | { namespace?: string }) =>
      createTranslator({
        locale: "en",
        messages,
        namespace: (typeof arg === "string" ? arg : arg?.namespace) as never,
      }),
  };
});

/** What the fixture gateway holds, by document address. A missing address is a gateway that gave nothing. */
const documents = vi.hoisted(() => new Map<string, { title?: string; thumbnailUrl?: string }>());

vi.mock("@/components/passport/art", async (real) => ({
  ...(await real<typeof import("@/components/passport/art")>()),
  readArt: async (uri: string) => {
    const held = documents.get(uri);
    return held === undefined ? { missing: true } : { ...held, missing: held.thumbnailUrl === undefined };
  },
}));

type Sheet = typeof import("@/components/explore/plates");
let plates: Sheet;
let ExploreSheet: typeof import("@/components/explore/Sheet").ExploreSheet;
let Grid: typeof import("@/components/explore/Grid").Grid;
let NoMatch: typeof import("@/components/explore/NoMatch").NoMatch;
let Plate: typeof import("@/components/explore/Plate").Plate;
let ReadingProvider: typeof import("@/components/explore/Reading").ReadingProvider;
let sort: typeof import("@/components/explore/sort");

beforeAll(async () => {
  vi.stubEnv("NEXT_PUBLIC_ENVIO_GRAPHQL_URL", INDEX_URL);
  plates = await import("@/components/explore/plates");
  ({ ExploreSheet } = await import("@/components/explore/Sheet"));
  ({ Grid } = await import("@/components/explore/Grid"));
  ({ NoMatch } = await import("@/components/explore/NoMatch"));
  ({ Plate } = await import("@/components/explore/Plate"));
  ({ ReadingProvider } = await import("@/components/explore/Reading"));
  sort = await import("@/components/explore/sort");
});

afterEach(() => {
  vi.unstubAllGlobals();
  documents.clear();
});

const SEARCH: ExploreSearch = { view: "pictures", search: "", agent: null, ai: null };

/** One index row, newest first by its number, pointing at a document of the same number. */
function row(index: number, uri = `ipfs://doc-${index}`) {
  return {
    id: `0x${(0xa000 + index).toString(16).padStart(64, "0")}`,
    kind: index % 2,
    registeredAt: String(2_000 - index),
    registeredBlock: "42",
    metadataURI: uri,
    manifestHash: `0x${"0".repeat(64)}`,
    disputed: false,
    attestationCount: 0,
    attestations: [],
    generator: null,
    consentStated: false,
    consentSummary: "none",
    consentAt: "0",
    consentAiTraining: 0,
    consentAiGenerativeTraining: 0,
    consentAiInference: 0,
    consentDataMining: 0,
  };
}

type Row = ReturnType<typeof row>;
type Clause = Record<string, unknown>;

/** The few where clauses the sheet writes, read the way the index reads them. */
function matches(one: Row, clause: Clause): boolean {
  if ("_and" in clause) {
    return (clause._and as Clause[]).every((part) => matches(one, part));
  }
  if ("_or" in clause) {
    return (clause._or as Clause[]).some((part) => matches(one, part));
  }
  const [field, test] = Object.entries(clause)[0] as [keyof Row, Record<string, unknown>];
  const value = one[field] as unknown;
  const [op, operand] = Object.entries(test)[0];
  const numeric = field === "registeredAt";
  if (op === "_eq") {
    return numeric ? Number(value) === Number(operand) : value === operand;
  }
  if (op === "_lt") {
    return numeric ? Number(value) < Number(operand) : String(value) < String(operand);
  }
  if (op === "_ilike") {
    const pattern = String(operand).toLowerCase();
    const body = pattern.replaceAll("%", "");
    const text = String(value).toLowerCase();
    return pattern.startsWith("%") ? text.includes(body) : text.startsWith(body);
  }
  throw new Error(`the fixture index does not read ${String(op)}`);
}

/** An index holding these rows. Every request it answers is kept, so a test can count them and read what they asked. */
function indexHolding(rows: Row[]) {
  const asked: { query: string; where: Clause; limit: number }[] = [];
  const calls = vi.fn(async (_url: string, init: { body: string }) => {
    const { query, variables } = JSON.parse(init.body) as {
      query: string;
      variables: { where?: Clause; limit?: number; cap?: number };
    };
    let data: unknown;
    if (query.includes("ExplorePassports")) {
      const where = variables.where ?? {};
      asked.push({ query: "ExplorePassports", where, limit: variables.limit ?? 0 });
      const left = rows.filter((one) => Object.keys(where).length === 0 || matches(one, where));
      data = { Passport: left.slice(0, variables.limit) };
    } else if (query.includes("RegistryCounts")) {
      asked.push({ query: "RegistryCounts", where: {}, limit: 0 });
      data = {
        GlobalStats: [{ passports: rows.length, passportsWithConsent: 3 }],
        generated: rows.filter((one) => one.kind === 0).map((one) => ({ id: one.id })),
        rechecked: [],
      };
    } else if (query.includes("PassportMetadata")) {
      asked.push({ query: "PassportMetadata", where: {}, limit: variables.limit ?? 0 });
      data = { Passport: rows.map((one) => ({ id: one.id, metadataURI: one.metadataURI })) };
    } else {
      throw new Error("the fixture index was asked something this test does not expect");
    }
    return { ok: true, json: async () => ({ data }) } as unknown as Response;
  });
  vi.stubGlobal("fetch", calls);
  return asked;
}

function picture(index: number, title: string): void {
  documents.set(`ipfs://doc-${index}`, { title, thumbnailUrl: `https://gateway.example/${index}.png` });
}

function render(node: ReactElement): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;
  return renderToStaticMarkup(createElement(Provider, { locale: "en", messages: en, timeZone: "UTC" }, node));
}

/** A server tree with every async component in it awaited, so the string renderer can draw it. */
async function settle(node: unknown): Promise<ReactNode> {
  if (Array.isArray(node)) {
    return Promise.all(node.map(settle));
  }
  if (!isValidElement(node)) {
    return node as ReactNode;
  }
  const element = node as { type: unknown; props: Record<string, unknown>; key: string | null };
  if (typeof element.type === "function" && element.type.constructor.name === "AsyncFunction") {
    return settle(await (element.type as (props: unknown) => Promise<unknown>)(element.props));
  }
  const props = { ...element.props, key: element.key };
  if (element.props.children === undefined) {
    return createElement(element.type as string, props);
  }
  return createElement(element.type as string, props, await settle(element.props.children));
}

/** The opening tag of the first element carrying the attribute. */
function tagOf(markup: string, attribute: string): string {
  const at = markup.indexOf(attribute);
  expect(at, `${attribute} is on the page`).toBeGreaterThan(-1);
  return markup.slice(markup.lastIndexOf("<", at), markup.indexOf(">", at) + 1);
}

function html(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}

describe("the opening from 1024 px up", () => {
  async function openingMarkup(): Promise<string> {
    const rows = [0, 1, 2, 3, 4].map((index) => row(index));
    rows.forEach((one, index) => picture(index, `Picture ${index}`));
    indexHolding(rows);
    return render((await settle(await ExploreSheet({ locale: "en", search: SEARCH, stored: false }))) as ReactElement);
  }

  it("draws the title, the counts strip, the chips and then the grid, in that order", async () => {
    const markup = await openingMarkup();
    const order = [
      markup.indexOf("<h1"),
      markup.indexOf("data-counts-strip"),
      markup.indexOf(`aria-label="${en.explore.chipsLabel}"`),
      markup.indexOf("data-ai-toggle"),
      markup.indexOf('class="mt-6 grid grid-cols-2'),
    ];
    expect(order.every((at) => at > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("sets the title on one row with the lede beside it, and leaves the poster behind", async () => {
    const markup = await openingMarkup();
    const title = tagOf(markup, "<h1");
    expect(title).toContain("lg:whitespace-nowrap");
    expect(title).toContain("lg:text-[3rem]");
    expect(tagOf(markup, 'data-opening="compact"')).toContain("lg:grid-cols-2");
    const lede = markup.slice(markup.lastIndexOf("<p", markup.indexOf(html(en.explore.lede))), markup.indexOf(html(en.explore.lede)));
    expect(lede).toContain("lg:justify-self-end");
    expect(markup).not.toContain("vertical-rl");
    // The rail's words are kept, beside the kicker.
    expect(markup).toContain(en.explore.rail);
  });

  it("keeps every count and the split on the one strip", async () => {
    const markup = await openingMarkup();
    expect(tagOf(markup, "data-counts-strip")).toContain("lg:flex");
    expect(tagOf(markup, "data-counts-grid")).toContain("lg:flex");
    for (const label of Object.values(en.explore.counts)) {
      expect(markup).toContain(label);
    }
    expect(markup).toContain("5 pictures");
  });

  it("folds the AI-use answers behind one chip in the row, and keeps every answer's link", async () => {
    const markup = await openingMarkup();
    expect(tagOf(markup, "data-ai-toggle")).toContain("lg:inline-flex");
    expect(markup).toContain(`${en.explore.ai.label}: ${en.explore.ai.any}`);
    expect(tagOf(markup, "data-ai-row")).toContain("lg:hidden");
    for (const ai of ["open", "closed", "ask", "none"]) {
      expect(markup).toMatch(new RegExp(`href="/explore/view[?][^"]*ai=${ai}"`));
    }
  });

  it("keeps the phone's compact opening as it was", async () => {
    const markup = await openingMarkup();
    const title = tagOf(markup, "<h1");
    expect(title).toContain("mt-2.5");
    expect(title).toContain("text-[clamp(1.75rem,8vw,2.25rem)]");
    expect(tagOf(markup, "data-counts-line")).toContain("sm:hidden");
    expect(tagOf(markup, "data-ai-row")).toContain("mt-2 flex");
  });

  it("offers a title or an id in the search box", async () => {
    const markup = await openingMarkup();
    expect(markup).toContain(`placeholder="${en.explore.searchAnyPlaceholder}"`);
    expect(markup).toContain(en.explore.searchAnyLabel);
  });
});

describe("the search box", () => {
  function registry(): Row[] {
    const rows = [...Array(6).keys()].map((index) => row(index));
    picture(0, "Humans on Mars");
    picture(1, "Chettinad Courtyard Before the Monsoon");
    picture(2, "mars at dawn");
    picture(3, "Kanchipuram Silk Loom");
    documents.set("ipfs://doc-4", { title: "Moolam seed 4", thumbnailUrl: "https://gateway.example/4.png" });
    picture(5, "Marsh birds");
    return rows;
  }

  it("sends an id to the index as it always has, in one query", async () => {
    const rows = registry();
    const asked = indexHolding(rows);
    const page = await plates.sheetPage({ ...SEARCH, view: "all", search: rows[3].id.toUpperCase().replace("0X", "0x") });

    expect(asked).toHaveLength(1);
    expect(JSON.stringify(asked[0].where)).toContain(`"_ilike":"${rows[3].id}%"`);
    expect(asked[0].limit).toBe(24);
    expect(page.plates.map((one) => one.id)).toEqual([rows[3].id]);
  });

  it("finds a title in any case, reading the index once and never asking it to match the words", async () => {
    const rows = registry();
    const asked = indexHolding(rows);
    const page = await plates.sheetPage({ ...SEARCH, view: "all", search: "MARS" });

    expect(asked).toHaveLength(1);
    expect(JSON.stringify(asked[0].where)).not.toContain("_ilike");
    expect(asked[0].limit).toBe(plates.TITLE_SCAN);
    expect(page.plates.map((one) => one.title)).toEqual(["Humans on Mars", "mars at dawn", "Marsh birds"]);
    expect(page.cursor).toBeNull();
  });

  it("keeps a kind chip on a title search, as a clause in the one query", async () => {
    const asked = indexHolding(registry());
    const page = await plates.sheetPage({ ...SEARCH, view: "generated", search: "mars" });

    expect(asked).toHaveLength(1);
    expect(JSON.stringify(asked[0].where)).toContain('"kind":{"_eq":0}');
    expect(page.plates.map((one) => one.title)).toEqual(["Humans on Mars", "mars at dawn"]);
  });

  it("keeps the Pictures chip on a title search, sifting the seed cards out by title", async () => {
    const rows = registry();
    documents.set("ipfs://doc-2", { title: "Moolam seed mars", thumbnailUrl: "https://gateway.example/2.png" });
    const asked = indexHolding(rows);
    const page = await plates.sheetPage({ ...SEARCH, view: "pictures", search: "mars" });

    expect(asked).toHaveLength(1);
    expect(page.plates.map((one) => one.title)).toEqual(["Humans on Mars", "Marsh birds"]);
  });

  it("pages the matches like any sheet, and carries on from the last one", async () => {
    const rows = [...Array(30).keys()].map((index) => row(index));
    rows.forEach((_, index) => picture(index, `Harbour ${index}`));
    const asked = indexHolding(rows);

    const first = await plates.sheetPage({ ...SEARCH, view: "all", search: "harbour" });
    expect(first.plates).toHaveLength(24);
    expect(first.cursor).toEqual({ registeredAt: rows[23].registeredAt, id: rows[23].id });

    const next = await plates.sheetPage({ ...SEARCH, view: "all", search: "harbour" }, first.cursor);
    expect(next.plates.map((one) => one.id)).toEqual(rows.slice(24).map((one) => one.id));
    expect(next.cursor).toBeNull();
    expect(asked).toHaveLength(2);
  });
});

describe("a sheet that matched nothing", () => {
  /** The sentence as a reader sees it, tags taken out. */
  function said(markup: string): string {
    const opens = markup.indexOf("<p", markup.indexOf("data-no-match"));
    return markup
      .slice(opens, markup.indexOf("</p>", opens))
      .replace(/<[^>]+>/g, "")
      .replaceAll("&amp;", "&");
  }

  function empty(search: ExploreSearch): string {
    return render(
      createElement(ReadingProvider, null, createElement(Grid, {
          first: [],
          cursor: null,
          search,
          indexError: null,
          empty: createElement(NoMatch, { search }),
        })),
    );
  }

  it("is what the page hands the grid for an empty first page", async () => {
    indexHolding([row(0, "ipfs://slow-not-a-match")]);
    const markup = render(
      (await settle(
        await ExploreSheet({ locale: "en", search: { ...SEARCH, view: "all", search: "lighthouse" }, stored: false }),
      )) as ReactElement,
    );
    expect(said(markup)).toBe(en.explore.noMatchQuery.replace("{query}", "lighthouse"));
    expect(markup).toContain("data-back-to-all");
  });

  it("names the search and offers the way back to all pictures, in the reader's language", () => {
    const markup = empty({ ...SEARCH, view: "all", search: "lighthouse" });
    expect(said(markup)).toBe(en.explore.noMatchQuery.replace("{query}", "lighthouse"));
    expect(tagOf(markup, "data-back-to-all")).toContain('href="/en/explore"');
    expect(markup).toContain(en.explore.backToAll);
  });

  it("sets the searched words apart by face and ground, never by quote marks", () => {
    const markup = empty({ ...SEARCH, view: "all", search: "  old harbour  " });
    const term = tagOf(markup, "data-no-match-query");
    expect(term).toContain("font-mono");
    expect(term).toContain("bg-bg-sunken");
    expect(markup).toMatch(/data-no-match-query="true"[^>]*>old harbour<\/span>\./);
    expect(said(markup)).not.toMatch(/["“”«»]/);
  });

  it("cuts a long search at a readable length and keeps the whole of it on hover", () => {
    const long = "a very long title somebody pasted in from a caption, far past forty letters";
    const markup = empty({ ...SEARCH, view: "all", search: long });
    const shown = markup.match(/data-no-match-query="true"[^>]*>([^<]*)<\/span>/)?.[1] ?? "";
    expect(shown.length).toBeLessThanOrEqual(40);
    expect(shown.endsWith("…")).toBe(true);
    expect(long.startsWith(shown.slice(0, -1))).toBe(true);
    expect(tagOf(markup, "data-no-match-query")).toContain(`title="${long}"`);
  });

  it("names the chip and the AI-use answer that narrowed it", () => {
    const markup = empty({ ...SEARCH, view: "disputed", ai: "ask" });
    expect(markup).toContain(html(en.explore.empty));
    const named = markup.slice(markup.indexOf("data-no-match-filters"));
    expect(named).toContain(en.explore.chips.disputed);
    expect(named).toContain(`${en.explore.ai.label}: ${en.explore.ai.ask}`);
    expect(markup).toContain(en.explore.backToAll);
  });

  it("offers no way back on the opening sheet, which is where it would lead", () => {
    const markup = empty(SEARCH);
    expect(markup).toContain(html(en.explore.empty));
    expect(markup).not.toContain("data-back-to-all");
  });
});

describe("a plate whose record did not load", () => {
  it("is built as unread, with its passport's own kind", async () => {
    const rows = [row(0), row(1, "ipfs://slow")];
    picture(0, "Moolam seed 2");
    indexHolding(rows);

    const built = await plates.buildPlates(rows.map((one) => ({
      id: one.id as `0x${string}`,
      kind: one.kind,
      registeredAt: BigInt(one.registeredAt),
      registeredBlock: 42n,
      metadataURI: one.metadataURI,
      manifest: false,
      rechecked: false,
      chainlink: false,
      disputed: false,
      inheritedDisputed: false,
      generatorId: null,
      consent: null,
    })));

    expect(built[1]).toMatchObject({ title: null, unread: true, kind: 1 });
    expect(built[0].unread).toBe(false);
  });

  it("sorts among the pictures, above a seed test card, and stays on the Pictures sheet", async () => {
    const rows = [row(0), row(1, "ipfs://slow"), row(2)];
    documents.set("ipfs://doc-0", { title: "Moolam seed 2", thumbnailUrl: "https://gateway.example/0.png" });
    picture(2, "Harbour at noon");
    indexHolding(rows);

    const page = await plates.sheetPage(SEARCH);
    expect(page.plates.map((one) => one.id).sort()).toEqual([rows[1].id, rows[2].id].sort());

    const ordered = sort.sortPlates([
      { id: rows[0].id, registeredAt: 3, title: "Moolam seed 2" },
      { id: rows[1].id, registeredAt: 1, title: null, unread: true },
    ]);
    expect(ordered.map((one) => one.id)).toEqual([rows[1].id, rows[0].id]);
    expect(sort.isTestCard(null, rows[1].id, true)).toBe(false);
    // A record that was read and has no title is still judged by the old rule.
    expect(sort.isTestCard(null, rows[1].id)).toBe(true);
  });

  it("counts as a picture in the split line", async () => {
    const rows = [row(0), row(1, "ipfs://slow")];
    documents.set("ipfs://doc-0", { title: "Moolam seed 2", thumbnailUrl: "https://gateway.example/0.png" });
    indexHolding(rows);

    expect(await plates.pictureSplit()).toEqual({ real: 1, test: 1, scanned: 2, capped: false });
  });

  it("never wears the seed test image label", () => {
    const plate: ExplorePlate = {
      id: row(1).id,
      kind: 0,
      registeredAt: 1_789_000_000,
      title: null,
      thumbnailUrl: null,
      manifest: false,
      rechecked: false,
      chainlink: false,
      disputed: false,
      agentId: null,
      consent: null,
      unread: true,
    };
    expect(render(createElement(Plate, { plate }))).not.toContain(en.explore.seedCard);
    expect(render(createElement(Plate, { plate: { ...plate, unread: false } }))).toContain(en.explore.seedCard);
  });
});
