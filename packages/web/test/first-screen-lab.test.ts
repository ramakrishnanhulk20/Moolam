import { createElement, type FunctionComponent, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import en from "@/messages/en.json";

/**
 * The first screen bench: what a stranger reads before any script has run, and
 * the rules every figure on it is read by.
 *
 * The page is rendered to a string the way the server sends it, with the reads
 * answered here in the network's stead, so what is held is the markup: the
 * headline and the line are in it as words, nothing hides them behind an
 * opacity a script would have to lift, and the route is closed without the
 * lab flag.
 */

const stub = vi.hoisted(() => ({ data: vi.fn() }));

vi.mock("@/components/home/read", () => ({ firstScreenData: stub.data }));

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
}));

vi.mock("@/components/passport/Picture", () => ({
  Picture: () => createElement("span", { "data-picture": true }),
}));

// The card only draws once a check has run, which a server render never has.
vi.mock("@/components/verify/AnswerCard", () => ({ AnswerCard: () => null }));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

vi.mock("next-intl/server", () => ({ setRequestLocale: () => undefined }));

const { default: FirstScreenLabPage } = await import("@/app/[locale]/lab/first-screen/page");
const { WORDS, SUMMARIES } = await import("@/components/lab/first-screen/words");
const { chainlinkRecheck, copyVerdict, FINDING_ID } = await import("@/components/home/finding");
const { drawingAsked } = await import("@/components/lab/first-screen/drawing");
const { copyLine, recheckLine, statementLine } = await import("@/components/lab/first-screen/lines");

const RECEIVER = "0x0d69055c43EAcb3B1ca687ca2263A049Bc7Eff04" as Hex;
const STRANGER = "0x1111111111111111111111111111111111111111" as Hex;
const PHASH = 7840506850305415717n;
const LONG_DASH = String.fromCharCode(0x2014);

const FINDING = {
  id: FINDING_ID,
  title: "Monsoon Fishing Nets Drying",
  picture: "https://gateway.example/ipfs/full",
  thumbnail: "https://gateway.example/ipfs/thumb",
  registeredAt: 1_788_881_666,
  phash: PHASH.toString(),
  recheck: { matched: true, distance: 0, at: 1_789_380_000 },
  statement: { summary: "closed" as const, at: 1_789_700_000 },
  statementError: null,
};

const COPY = {
  image: "data:image/jpeg;base64,AAAA",
  width: 360,
  height: 360,
  bytes: 4080,
  phash: (PHASH ^ 0b10101n).toString(),
  found: true,
  distance: 3,
  confidence: 0.55,
  measuredAt: 1_790_000_000_000,
};

const SAMPLES = [{ id: `0x${"2b".repeat(32)}` as Hex, url: "https://gateway.example/ipfs/ant", title: "Ant and Elephants" }];

async function drawn(search: Record<string, string> = {}): Promise<string> {
  const page = await FirstScreenLabPage({
    params: Promise.resolve({ locale: "en" }),
    searchParams: Promise.resolve(search),
  });
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
    children: ReactNode;
  }>;
  return renderToString(createElement(Provider, { locale: "en", messages: en, timeZone: "UTC" }, page));
}

/** The first screen's own words, which both drawings share with the home page. */
const FIRST = en.home.first;
const BILLING = Object.values(FIRST.billing);

/** The text of the markup with the tags taken out, so a sentence split across elements still reads whole. */
function text(html: string): string {
  return html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .replace(/ ([.,:])/g, "$1");
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_LAB_PAGES", "1");
  stub.data.mockReset().mockResolvedValue({ finding: { read: FINDING }, copy: { read: COPY }, samples: SAMPLES });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the words a stranger reads before any script", () => {
  for (const drawing of ["a", "b"] as const) {
    it(`are in drawing ${drawing}'s server markup: the headline, the line and the action`, async () => {
      const words = text(await drawn({ d: drawing }));

      expect(words).toContain(`${FIRST.headline} ${FIRST.headlineTail}`);
      expect(words).toContain(FIRST.line);
      expect(words).toContain(FIRST.drop);
      expect(words).toContain("Ant and Elephants");
      expect(words).toContain(FIRST.make);
      for (const credit of BILLING) {
        expect(words).toContain(credit);
      }
    });

    it(`hides nothing in drawing ${drawing} behind an opacity only a script would lift`, async () => {
      const html = await drawn({ d: drawing });
      const headline = html.slice(html.indexOf("data-first-line"), html.indexOf("</h1>"));

      expect(headline).not.toMatch(/opacity:\s*0/);
      expect(html).not.toMatch(/style="[^"]*opacity:\s*0[;"]/);
    });
  }

  it("quotes the live finding in the poster's credit block", async () => {
    const words = text(await drawn({ d: "a" }));

    expect(words).toContain("Monsoon Fishing Nets Drying");
    expect(words).toContain("found, 3 of 64 bits apart");
    expect(words).toContain("Re-checked by Chainlink on Sep 14, 2026: 0 of 64 bits apart");
    expect(words).toContain("Not for AI training");
  });

  it("draws both fingerprints on the evidence board, with a ring on every bit the two disagree on", async () => {
    const html = await drawn({ d: "b" });

    expect(html.match(/class="fs-lit /g)?.length ?? 0).toBe(2 * 3);
    expect(text(html)).toContain("3 of 64 bits apart: the same picture.");
    expect(html).toContain(COPY.image);
  });

  it("says the copy was not found when the service did not name this passport", async () => {
    stub.data.mockResolvedValue({
      finding: { read: FINDING },
      copy: { read: { ...COPY, found: false, distance: 21 } },
      samples: SAMPLES,
    });

    expect(text(await drawn({ d: "b" }))).toContain("21 of 64 bits apart, and the verify service did not find it.");
    expect(text(await drawn({ d: "a" }))).toContain("not found, 21 of 64 bits apart");
  });
});

describe("the bench around the drawings", () => {
  it("opens the poster unless b is asked for", () => {
    expect(drawingAsked(undefined)).toBe("a");
    expect(drawingAsked("b")).toBe("b");
    expect(drawingAsked(["b"])).toBe("a");
    expect(drawingAsked("c")).toBe("a");
  });

  it("carries the toggle and the film seam, and drops the toggle at the real viewport", async () => {
    const bench = await drawn({ d: "b" });
    expect(bench).toContain('href="/lab/first-screen?d=a"');
    expect(bench).toContain('data-drawing="b"');
    expect(text(bench)).toContain(WORDS.filmFollows);

    const full = await drawn({ d: "b", full: "1" });
    expect(full).not.toContain('href="/lab/first-screen?d=a"');
    expect(full).toContain('data-drawing="b"');
  });

  it("is a 404 without the lab flag, before anything is read", async () => {
    vi.stubEnv("NEXT_PUBLIC_LAB_PAGES", "");

    await expect(drawn()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(stub.data).not.toHaveBeenCalled();
  });
});

describe("the rules every figure is read by", () => {
  it("names only a re-check written through a Chainlink receiver, and the newest of those", () => {
    const rows = [
      { receiver: RECEIVER, matched: true, distance: 1, at: 100n },
      { receiver: STRANGER, matched: false, distance: 30, at: 300n },
      { receiver: RECEIVER.toLowerCase() as Hex, matched: true, distance: 0, at: 200n },
    ];

    expect(chainlinkRecheck(rows, [RECEIVER])).toEqual({ matched: true, distance: 0, at: 200 });
    expect(chainlinkRecheck([rows[1]], [RECEIVER])).toBeNull();
  });

  it("counts the copy's distance off the two fingerprints and calls it found only for this passport", () => {
    const answer = {
      exact: null,
      best: { id: FINDING_ID, phashDistance: 99 },
      confidence: 0.6,
      queried: { phash: (PHASH ^ 0b111n).toString() },
    };

    expect(copyVerdict(answer, FINDING_ID, PHASH.toString())).toMatchObject({ found: true, distance: 3, confidence: 0.6 });
    expect(
      copyVerdict({ ...answer, best: { id: `0x${"ee".repeat(32)}`, phashDistance: 0 } }, FINDING_ID, PHASH.toString()),
    ).toMatchObject({ found: false, distance: 3, confidence: 0 });
    expect(copyVerdict({ ...answer, best: null }, FINDING_ID, PHASH.toString()).found).toBe(false);
  });

  it("says plainly when a read failed rather than borrowing a figure", () => {
    expect(copyLine({ failed: "offline" }).fact).toBe("the verify service did not answer this minute");
    expect(recheckLine({ ...FINDING, recheck: null }).fact).toBe("no re-check written for this passport yet");
    expect(statementLine({ ...FINDING, statement: null, statementError: "timeout" }, SUMMARIES).fact).toBe(
      "the consent register did not answer this minute",
    );
    expect(statementLine({ ...FINDING, statement: null }, SUMMARIES).fact).toBe(SUMMARIES.none);
  });

  it("names each statement exactly as the passport page does", () => {
    expect(SUMMARIES).toEqual(en.passport.consent.summary);
  });

  it("keeps the line under thirty words and every word on the bench free of long dashes", () => {
    expect(FIRST.line.split(/\s+/).length).toBeLessThan(30);
    expect(JSON.stringify([WORDS, SUMMARIES, FIRST])).not.toContain(LONG_DASH);
  });
});
