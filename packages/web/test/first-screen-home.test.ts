import { createElement, type FunctionComponent, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import en from "@/messages/en.json";

/**
 * The home page's first screen: the live finding it is built from, and what it
 * shows when any part of that finding could not be read.
 *
 * The rule under test: the copy and the call to the verify service happen on
 * the server, when the site is built or when a background rebuild finds the
 * hold empty, and a read that failed takes its facts off the screen rather
 * than leaving a number behind that nobody read.
 */

const stub = vi.hoisted(() => ({
  record: vi.fn(),
  consent: vi.fn(),
  art: vi.fn(),
  index: vi.fn(),
  offered: vi.fn(),
  verify: vi.fn(),
}));

vi.mock("next/cache", () => ({ unstable_cache: (read: (...args: unknown[]) => unknown) => read }));
vi.mock("@/lib/chain/registry", () => ({ heldPassportRecord: stub.record }));
vi.mock("@/lib/chain/consent", () => ({ heldConsent: stub.consent, plainStatement: () => "closed" }));
vi.mock("@/lib/data/passports", () => ({ heldArt: stub.art, askIndex: stub.index }));
vi.mock("@/lib/data/offeredSamples", () => ({ offeredSamples: stub.offered }));
vi.mock("@/lib/verifier/client", () => ({ verify: stub.verify }));

// The copy is made by sharp from the gateway's bytes. Its pixels are not what
// is under test here, only whether it is made at all and how often.
vi.mock("sharp", () => {
  const chain = {
    metadata: async () => ({ width: 512, height: 512 }),
    extract: () => chain,
    modulate: () => chain,
    resize: () => chain,
    jpeg: () => chain,
    toBuffer: async () => ({ data: Buffer.from([1, 2, 3, 4]), info: { width: 360, height: 353 } }),
  };
  return { default: () => chain };
});

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown; className?: string; "data-hero-call"?: string }) =>
    createElement(
      "a",
      { href: props.href, className: props.className, "data-hero-call": props["data-hero-call"] },
      props.children as never,
    ),
}));
vi.mock("@/components/passport/Picture", () => ({
  Picture: (props: { alt?: string }) => createElement("span", { "data-picture": props.alt ?? "" }),
}));
vi.mock("@/components/verify/AnswerCard", () => ({ AnswerCard: () => null }));

const { addresses } = await import("@/lib/chain/client");
const { FINDING_ID } = await import("@/components/home/finding");
const { firstScreenData, holdFirstScreen } = await import("@/components/home/read");
const { Board } = await import("@/components/home/Board");

const PHASH = 7840506850305415717n;
const COPY_PHASH = PHASH ^ 0b11111n;
const THUMB = "https://gateway.example/ipfs/thumb";
const TITLE = "Monsoon Fishing Nets Drying";

function record() {
  return {
    passport: {
      id: FINDING_ID,
      metadataURI: "ipfs://doc",
      registeredAt: 1_788_881_666n,
      phash: PHASH,
    },
    attestations: [{ receiver: addresses.receiver as Hex, matched: true, distance: 0, at: 1_789_380_000n }],
  };
}

let gatewayAsked = 0;

beforeEach(() => {
  gatewayAsked = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      gatewayAsked += 1;
      return new Response(new Uint8Array([9, 9, 9]), { status: 200 });
    }),
  );
  stub.record.mockReset().mockResolvedValue(record());
  stub.consent.mockReset().mockResolvedValue({ stated: true, entry: { consent: {}, at: 1_789_700_000n } });
  stub.art.mockReset().mockResolvedValue({ title: TITLE, thumbnailUrl: THUMB, imageUrl: "https://gateway.example/ipfs/full" });
  stub.index.mockReset().mockResolvedValue({ Passport: [{ metadataURI: "ipfs://doc" }] });
  stub.offered.mockReset().mockResolvedValue({ samples: [], error: null });
  stub.verify.mockReset().mockResolvedValue({
    result: { exact: null, best: { id: FINDING_ID, phashDistance: 5 }, confidence: 0.6, queried: { phash: COPY_PHASH.toString() } },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the live finding, read when the page is built", () => {
  it("makes the copy while the site is built, once for all ten languages", async () => {
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    vi.stubEnv("NODE_ENV", "production");

    const ten = await Promise.all(Array.from({ length: 10 }, () => firstScreenData()));

    expect(stub.verify).toHaveBeenCalledTimes(1);
    expect(gatewayAsked).toBe(1);
    for (const data of ten) {
      expect(data.copy).toMatchObject({ read: { found: true, distance: 5, phash: COPY_PHASH.toString() } });
      expect(data.finding).toMatchObject({ read: { title: TITLE, recheck: { matched: true, distance: 0 } } });
      expect(data.loose).toBeNull();
    }
  });

  it("makes the copy in a rebuild after launch when the hold is empty, rather than losing it", async () => {
    vi.stubEnv("NEXT_PHASE", "");
    vi.stubEnv("NODE_ENV", "production");
    // A thumbnail of its own, so the making the test above shared inside this
    // process is not what answers.
    stub.art.mockResolvedValue({ title: TITLE, thumbnailUrl: "https://gateway.example/ipfs/runtime-thumb" });

    const data = await firstScreenData();

    // The hold is stood in for by a plain call in this file, so every read is
    // an empty hold. first-screen-runtime-copy.test.ts holds the once-then-read rule.
    expect(stub.verify).toHaveBeenCalledTimes(1);
    expect(gatewayAsked).toBe(1);
    expect(data.copy).toMatchObject({ read: { found: true, distance: 5 } });
    expect(data.finding).toMatchObject({ read: { recheck: { distance: 0 }, statement: { summary: "closed" } } });
  });

  it("keeps the picture, its name and the statement when the registry itself will not answer", async () => {
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    stub.record.mockRejectedValue(new Error("the RPC endpoint answered 503"));

    const data = await firstScreenData();

    expect(data.finding).toEqual({ failed: "the RPC endpoint answered 503" });
    expect(data.copy).toMatchObject({ failed: expect.stringContaining("registry record") });
    expect(stub.verify).not.toHaveBeenCalled();
    expect(stub.index).toHaveBeenCalledWith(expect.any(String), { ids: [FINDING_ID.toLowerCase()] });
    expect(data.loose).toEqual({
      id: FINDING_ID,
      title: TITLE,
      thumbnail: THUMB,
      statement: { summary: "closed", at: 1_789_700_000 },
    });
  });

  it("keeps only the picture and its name when nothing else could be read", async () => {
    stub.record.mockRejectedValue(new Error("down"));
    stub.consent.mockRejectedValue(new Error("down"));

    const data = await firstScreenData();

    expect(data.loose).toEqual({ id: FINDING_ID, title: TITLE, thumbnail: THUMB, statement: null });
  });

  it("holds the copy before the build draws the pages, and lets the build go on without it when the service fails", async () => {
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const thumbnail = "https://gateway.example/ipfs/another-thumb";
    stub.art.mockResolvedValue({ title: TITLE, thumbnailUrl: thumbnail });
    stub.verify.mockRejectedValueOnce(new Error("the verify service answered 502"));

    expect(await holdFirstScreen()).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("the verify service answered 502"));

    expect(await holdFirstScreen()).toBe(true);
    expect(stub.verify).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });

  it("has nothing loose to show when even the index and the gateway are silent", async () => {
    stub.record.mockRejectedValue(new Error("down"));
    stub.consent.mockRejectedValue(new Error("down"));
    stub.index.mockRejectedValue(new Error("down"));

    expect((await firstScreenData()).loose).toBeNull();
  });
});

/** The text of the markup with the tags taken out, so a sentence split across elements still reads whole. */
function text(html: string): string {
  return html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .replace(/ ([.,:])/g, "$1");
}

const FINDING = {
  id: FINDING_ID,
  title: TITLE,
  picture: "https://gateway.example/ipfs/full",
  thumbnail: THUMB,
  registeredAt: 1_788_881_666,
  phash: PHASH.toString(),
  recheck: { matched: true, distance: 0, at: 1_789_380_000 },
  statement: { summary: "closed" as const, at: 1_789_700_000 },
  statementError: null,
};

const COPY = {
  image: "data:image/jpeg;base64,AAAA",
  width: 360,
  height: 353,
  bytes: 4080,
  phash: COPY_PHASH.toString(),
  found: true,
  distance: 5,
  confidence: 0.6,
  measuredAt: 1_790_380_000_000,
};

type BoardProps = Parameters<typeof Board>[0];

function board(over: Partial<BoardProps>): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
    children: ReactNode;
  }>;
  return renderToString(
    createElement(
      Provider,
      { locale: "en", messages: en, timeZone: "UTC" },
      createElement(Board, { finding: { read: FINDING }, copy: { read: COPY }, samples: [], loose: null, ...over }),
    ),
  );
}

describe("what the first screen shows of the finding", () => {
  it("shows both exhibits, both fingerprints and the verdict when everything was read", () => {
    const html = board({});
    const words = text(html);

    expect(words).toContain("Exhibit A");
    expect(words).toContain("Exhibit B");
    expect(words).toContain("5 of 64 bits apart: the same picture.");
    expect(words).toContain("Chainlink re-checked the registered picture itself on Sep 14, 2026: 0 of 64 bits from its record");
    expect(words).toContain("Not for AI training");
    expect(html).toContain(COPY.image);
    expect(html.match(/class="fs-lit /g)?.length ?? 0).toBe(2 * 5);
  });

  it("takes the copy's exhibit and its number away when the copy was not measured, and keeps the chain's facts", () => {
    const html = board({ copy: { failed: "the copy is only made while the site is built" } });
    const words = text(html);

    expect(words).not.toContain("Exhibit B");
    expect(html).not.toContain("data:image");
    expect(html).not.toContain("data-first-verdict");
    expect(html).not.toMatch(/class="fs-lit /);
    expect(words).not.toContain("only made while");
    expect(words).toContain("Exhibit A");
    expect(words).toContain("Chainlink re-checked the registered picture itself on Sep 14, 2026: 0 of 64 bits from its record");
    expect(words).toContain("Not for AI training");
  });

  it("leaves the statement out when the register did not answer, rather than saying something about it", () => {
    const words = text(board({ finding: { read: { ...FINDING, statement: null, statementError: "timeout" } } }));

    expect(words).not.toContain("AI use");
    expect(words).not.toContain("did not answer");
    expect(words).toContain("Chainlink re-checked the registered picture");
  });

  it("shows the picture, its name and the statement when the registry would not answer", () => {
    const html = board({
      finding: { failed: "down" },
      copy: { failed: "no record" },
      loose: { id: FINDING_ID, title: TITLE, thumbnail: THUMB, statement: FINDING.statement },
    });
    const words = text(html);

    expect(html).toContain(`data-picture="${TITLE}"`);
    expect(words).toContain(TITLE);
    expect(words).toContain("Not for AI training");
    expect(words).not.toContain("Chainlink re-checked");
    expect(words).not.toMatch(/\d+ of 64/);
    expect(words).not.toContain("Fingerprint");
  });

  it("shows the picture and its name only when nothing else could be read", () => {
    const words = text(
      board({
        finding: { failed: "down" },
        copy: { failed: "no record" },
        loose: { id: FINDING_ID, title: TITLE, thumbnail: THUMB, statement: null },
      }),
    );

    expect(words).toContain(TITLE);
    expect(words).not.toContain("AI use");
    expect(words).not.toContain("AI training");
    expect(words).not.toMatch(/\d+ of 64/);
  });

  it("draws no exhibit at all when not even the picture could be read, and keeps the sponsor line", () => {
    const html = board({ finding: { failed: "down" }, copy: { failed: "no record" }, loose: null });

    expect(text(html)).not.toContain("Exhibit");
    expect(html).toContain("data-first-billing");
  });
});

describe("what the first-visit walk reads off the first screen", () => {
  it("carries the walk's mark in the server's markup, on the column with the headline", () => {
    const html = board({});
    const column = html.slice(html.indexOf("data-hero-shown"));
    expect(html.match(/data-hero-shown="true"/g)?.length).toBe(1);
    expect(column.indexOf("<h1")).toBeGreaterThan(-1);
    expect(column.indexOf("<h1")).toBeLessThan(column.indexOf("data-first-drop"));
  });

  it("marks its two calls and nothing else as calls: the Choose an image button and Make one", () => {
    const html = board({});
    expect(html).toMatch(/<button[^>]*data-hero-call="choose"[^>]*>Choose an image<\/button>/);
    expect(html).toMatch(/<a[^>]*data-hero-call="make"[^>]*>Make one/);
    expect(html.match(/data-hero-call=/g)?.length).toBe(2);
  });

  it("marks the headline and its line as words the walk keeps clear of", () => {
    const html = board({});
    expect(html).toMatch(/<h1[^>]*data-hero-words[^>]*>/);
    expect(html).toMatch(/<p[^>]*data-first-why[^>]*data-hero-words[^>]*>/);
    expect(html.match(/data-hero-words/g)?.length).toBe(2);
  });
});

describe("the home page's headings", () => {
  it("has exactly one h1 in the server's markup, and it is the first screen's headline", async () => {
    const { FilmGate } = await import("@/components/home/FilmGate");
    const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
      locale: string;
      messages: unknown;
      timeZone: string;
      children: ReactNode;
    }>;
    // The page as app/[locale]/page.tsx draws it on the server: the board, then
    // the film's held box. The film itself is browser only.
    const html = renderToString(
      createElement(
        Provider,
        { locale: "en", messages: en, timeZone: "UTC" },
        createElement(Board, { finding: { read: FINDING }, copy: { read: COPY }, samples: [], loose: null }),
        createElement(FilmGate, null, createElement("div", null, "film")),
      ),
    );
    expect(html.match(/<h1[\s>]/g)?.length).toBe(1);
    expect(html).toMatch(/<h1[^>]*data-first-line/);
  });
});
