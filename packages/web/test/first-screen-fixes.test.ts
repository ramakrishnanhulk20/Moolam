import { readFileSync } from "node:fs";
import { createElement, type FunctionComponent, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import de from "@/messages/de.json";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import fr from "@/messages/fr.json";
import hi from "@/messages/hi.json";
import ja from "@/messages/ja.json";
import ko from "@/messages/ko.json";
import pt from "@/messages/pt.json";
import ta from "@/messages/ta.json";
import zh from "@/messages/zh.json";

/**
 * The first screen's reading fixes of 25 September: each distance
 * says what it compares, the phone's box never asks for a drop, a phone gets
 * one line pointing at the evidence, sample names are shown whole, and the
 * laptop header leaves home to the logo.
 */

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

const { FINDING_ID } = await import("@/components/home/finding");
const { Board } = await import("@/components/home/Board");

const MESSAGES = { en, ta, hi, zh, ja, ko, es, fr, de, pt } as const;
type Locale = keyof typeof MESSAGES;

const PHASH = 7840506850305415717n;

const FINDING = {
  id: FINDING_ID,
  title: "Monsoon Fishing Nets Drying",
  picture: "https://gateway.example/ipfs/full",
  thumbnail: "https://gateway.example/ipfs/thumb",
  registeredAt: 1_788_881_666,
  phash: PHASH.toString(),
  recheck: { matched: true, distance: 3, at: 1_789_380_000 },
  statement: null,
  statementError: null,
};

const COPY = {
  image: "data:image/jpeg;base64,AAAA",
  width: 360,
  height: 353,
  bytes: 4080,
  phash: (PHASH ^ 0b1111111n).toString(),
  found: true,
  distance: 7,
  confidence: 0.6,
  measuredAt: 1_790_380_000_000,
};

const SAMPLES = [
  { id: `0x${"2b".repeat(32)}` as Hex, url: "https://gateway.example/ipfs/a", title: "Ant and Elephants" },
  { id: `0x${"3c".repeat(32)}` as Hex, url: "https://gateway.example/ipfs/b", title: "Kanchipuram Silk Loom at First Light" },
  { id: `0x${"4d".repeat(32)}` as Hex, url: "https://gateway.example/ipfs/c", title: "Chettinad Courtyard Before the Monsoon" },
];

type BoardProps = Parameters<typeof Board>[0];

function board(over: Partial<BoardProps> = {}, locale: Locale = "en"): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
    children: ReactNode;
  }>;
  return renderToString(
    createElement(
      Provider,
      { locale, messages: MESSAGES[locale], timeZone: "UTC" },
      createElement(Board, { finding: { read: FINDING }, copy: { read: COPY }, samples: SAMPLES, loose: null, ...over }),
    ),
  );
}

function text(html: string): string {
  return html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .replace(/ ([.,:])/g, "$1");
}

/** The opening tag of the first element carrying the attribute, with its class. */
function tag(html: string, attribute: string): string {
  const at = html.indexOf(attribute);
  expect(at).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<", at), html.indexOf(">", at) + 1);
}

describe("the two distances say what they compare", () => {
  it("labels the big figure as the copy against the registered picture, above it", () => {
    const html = board();
    const verdict = html.slice(html.indexOf("data-first-verdict"));
    const words = text(verdict);
    expect(words).toContain("This copy against the registered picture 7 of 64 bits apart: the same picture.");
  });

  it("drops the label with the figure when the copy was not measured", () => {
    expect(text(board({ copy: { failed: "not built" } }))).not.toContain("This copy against");
  });

  it("says Chainlink re-checked the registered picture, with the distance from its record", () => {
    expect(text(board())).toContain(
      "Chainlink re-checked the registered picture itself on Sep 14, 2026: 3 of 64 bits apart from its record.",
    );
  });

  it("says the same kind of thing when the re-check missed", () => {
    const missed = { ...FINDING, recheck: { matched: false, distance: 21, at: 1_789_380_000 } };
    expect(text(board({ finding: { read: missed } }))).toContain(
      "Chainlink re-checked the registered picture itself on Sep 14, 2026: did not match, 21 of 64 bits apart from its record.",
    );
  });

  it("names the registered picture when there is no re-check yet", () => {
    expect(text(board({ finding: { read: { ...FINDING, recheck: null } } }))).toContain(
      "Chainlink: no re-check of the registered picture written yet.",
    );
  });

  it("calls the panel a real passport and a copy we altered", () => {
    expect(text(board())).toContain("A real passport, and a copy we altered");
  });
});

describe("the box's title on a phone and on a laptop", () => {
  for (const locale of Object.keys(MESSAGES) as Locale[]) {
    it(`sends both titles in the server's markup, swapped by CSS alone, in ${locale}`, () => {
      const first = MESSAGES[locale].home.first;
      const html = board({}, locale);
      const phone = tag(html, 'data-first-title="phone"');
      const laptop = tag(html, 'data-first-title="laptop"');
      expect(phone).toMatch(/class="lg:hidden"/);
      expect(laptop).toMatch(/class="hidden lg:inline"/);
      expect(text(html)).toContain(first.check);
      expect(text(html)).toContain(first.drop);
    });
  }
});

describe("the phone's pointer to the evidence", () => {
  it("quotes the copy's own measured distance and points at the finding", () => {
    const html = board();
    const link = tag(html, "data-first-proof");
    expect(link).toContain('href="#finding"');
    expect(link).toContain("lg:hidden");
    expect(text(html)).toContain("7 of 64 bits apart: see the proof");
    expect(html).toMatch(/id="finding"/);
  });

  it("carries a different number when the copy measured a different one", () => {
    expect(text(board({ copy: { read: { ...COPY, distance: 12 } } }))).toContain("12 of 64 bits apart: see the proof");
  });

  it("is not drawn when the copy was not measured", () => {
    const html = board({ copy: { failed: "the copy is only made while the site is built" } });
    expect(html).not.toContain("data-first-proof");
    expect(text(html)).not.toContain("see the proof");
  });

  it("is not drawn when the registry record could not be read", () => {
    const html = board({
      finding: { failed: "down" },
      copy: { failed: "no record" },
      loose: { id: FINDING_ID, title: FINDING.title, thumbnail: FINDING.thumbnail, statement: null },
    });
    expect(html).not.toContain("data-first-proof");
  });

  it("is not one of the walk's calls", () => {
    expect(board().match(/data-hero-call=/g)?.length).toBe(2);
  });
});

describe("Make one, the second call", () => {
  it("is a solid button in the page's colours turned round, and Choose keeps the only accent fill", () => {
    const html = board();
    const make = tag(html, 'data-hero-call="make"');
    expect(make).toContain("bg-text");
    expect(make).toContain("text-bg");
    expect(make).toContain("h-11");
    expect(make).not.toContain("bg-accent");
    const choose = tag(html, 'data-hero-call="choose"');
    expect(choose).toContain("h-11");
    expect(choose).toContain("bg-accent");
  });
});

describe("sample names", () => {
  it("are shown whole, never cut or clamped", () => {
    const html = board();
    for (const sample of SAMPLES) {
      expect(text(html)).toContain(sample.title);
    }
    const strip = html.slice(html.indexOf("data-first-samples"));
    expect(strip).not.toMatch(/line-clamp|truncate|text-ellipsis|break-all|overflow-wrap:anywhere/);
  });

  it("wrap only at spaces in the source as well", () => {
    const source = readFileSync("components/home/Drop.tsx", "utf8");
    const strip = source.slice(source.indexOf("function Strip("));
    expect(strip).not.toMatch(/line-clamp|truncate|text-ellipsis|break-all|overflow-wrap:anywhere/);
    expect(strip).toContain("[word-break:normal]");
  });
});

describe("the header's way home", () => {
  const layout = readFileSync("app/[locale]/layout.tsx", "utf8");

  it("has no Home link in the laptop nav, where the logo is home", () => {
    const nav = layout.slice(layout.indexOf("const nav = ["), layout.indexOf("] as const;"));
    expect(nav).not.toContain('href: "/",');
    expect(nav).not.toContain("nav.home");
    expect(nav).toContain('href: "/explore"');
  });

  it("keeps the Home tab in the phone's bar", () => {
    const tabs = layout.slice(layout.indexOf("const tabs: Tab[] = ["), layout.indexOf("];", layout.indexOf("const tabs")));
    expect(tabs).toContain('{ key: "home", href: "/", label: bar("tabs.home") }');
  });
});
