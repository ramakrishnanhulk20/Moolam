import { readFileSync } from "node:fs";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import en from "@/messages/en.json";
import ta from "@/messages/ta.json";
import type { StoryData } from "@/components/story/data";

/**
 * The film told as a chapter under the home page's first screen. Ram approved
 * it on the lab page on 2026-09-25 and it is now what the home page plays.
 *
 * What is held here: the chapter cut opens on a chapter title with no poster
 * and no buttons, its last card's first call is named as on the first screen,
 * its words are in all ten languages, and the home page draws it in English
 * and Tamil.
 */

type Target = { pathname: string; query?: Record<string, string> } | string;

const asked = vi.hoisted(() => [] as { href: string; prefetch: boolean | undefined; words: string }[]);
const reads = vi.hoisted(() => ({ story: vi.fn(), first: vi.fn() }));

function words(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(words).join("");
  return "";
}

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: Target; prefetch?: boolean; className?: string; children?: unknown }) => {
    const href =
      typeof props.href === "string"
        ? props.href
        : `${props.href.pathname}?${new URLSearchParams(props.href.query ?? {}).toString()}`;
    asked.push({ href, prefetch: props.prefetch, words: words(props.children).trim() });
    return createElement("a", { href, className: props.className }, props.children as never);
  },
  useRouter: () => ({ refresh: () => undefined }),
  usePathname: () => "/",
}));

vi.mock("next-intl/server", () => ({ setRequestLocale: () => undefined }));

// The home page's reads and heavy parts, answered here. The film itself is the
// real one: the stage's browser-only loader is swapped for the film it loads,
// so the page draws on the server what a browser would be handed.
vi.mock("@/components/story/data", () => ({ heldStory: reads.story }));
vi.mock("@/components/home/read", () => ({ firstScreenData: reads.first }));
vi.mock("@/components/home/Board", () => ({ Board: () => createElement("section", { "data-board": true }) }));
vi.mock("@/components/guide/FirstVisitGuide", () => ({ FirstVisitGuide: () => null }));
vi.mock("@/components/home/FilmGate", () => ({
  FilmGate: (props: { children?: unknown }) => createElement("div", { "data-gate": true }, props.children as never),
}));
vi.mock("@/components/story/StoryStage", async () => {
  const { LandingStory: Film } = await import("@/components/story/LandingStory");
  return {
    StoryStage: (props: { data: StoryData; variant: "chapter" }) =>
      createElement("div", { "data-stage": props.variant }, createElement(Film, props)),
  };
});

const { LandingStory } = await import("@/components/story/LandingStory");
const { CloseCard } = await import("@/components/story/CloseCard");
const { ChapterOpening } = await import("@/components/story/ChapterOpening");
const { storyCut } = await import("@/components/story/stated");
const { default: HomePage } = await import("@/app/[locale]/page");

const LOCALES = ["en", "de", "es", "fr", "hi", "ja", "ko", "pt", "ta", "zh"] as const;

/**
 * The old poster opening's words and its closing card's first call. They left
 * the message files with the lab benches, the last screens that said them, and
 * the film must never say them again.
 */
const RETIRED = {
  line: "Every image gets a passport.",
  kicker: "Live on Monad mainnet",
  credit: "Make one, or check one",
  generate: "Generate an image",
  verify: "Verify a copy",
  register: "Register an image",
  generateTa: "ஒரு படத்தை உருவாக்கு",
};

function render(node: ReactElement, locale = "en", messages: unknown = en): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;
  return renderToStaticMarkup(createElement(Provider, { locale, messages, timeZone: "UTC" }, node));
}

const WRITER = "0x85a88Ca81ff5f681D96AB86fa60ccB8452A139a6" as Hex;

const data: StoryData = {
  source: "envio",
  plates: [],
  focal: {
    id: `0x${"f0".repeat(32)}` as Hex,
    picture: "https://example.test/picture.jpg",
    creator: WRITER,
    agentId: "7",
    registeredAt: 1_789_648_000,
    block: "12345678",
    kind: 0,
    manifest: true,
    attestations: 1,
    why: "full",
    measured: false,
  },
  attestation: null,
  agent: null,
  statement: {
    summary: "closed",
    consent: { aiTraining: "notAllowed", aiGenerativeTraining: "notAllowed", aiInference: "notAllowed", dataMining: "notAllowed" },
    at: 1_789_717_128,
    writer: WRITER,
    constraintInfo: "",
  },
  statementError: null,
  passportCount: 41,
  attestationCount: 20,
  error: null,
};

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

/** The first section of the still page: the film's opening, as a server draws it. */
function opening(html: string): string {
  const from = html.indexOf("<section");
  return html.slice(from, html.indexOf("</section>", from) + "</section>".length);
}

/** The headings and links of a block, in order: the markers a change to its opening or closing would move. */
function markers(html: string) {
  return {
    headings: [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)].map((m) => text(m[1])),
    links: [...html.matchAll(/<a href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => `${m[1]} ${text(m[2])}`),
  };
}

beforeEach(() => {
  asked.length = 0;
});

describe("the chapter cut's opening", () => {
  const film = render(createElement(LandingStory, { data, variant: "chapter" as const }));
  const first = opening(film);

  it("opens on the chapter title, with no poster and no buttons", () => {
    expect(text(first)).toBe(`${en.story.chapter.kicker} ${en.story.chapter.title}`);
    expect(first).not.toContain("<a ");
    expect(film).not.toContain(`>${en.story.title}</h2>`);
    expect(film).not.toContain(RETIRED.line);
    expect(film).not.toContain(RETIRED.kicker);
    expect(film).not.toContain(RETIRED.credit);
    expect(film).not.toContain(RETIRED.generate);
    expect(film).not.toContain("mode=generate");
  });

  it("is a chapter heading at the size of the beats after it, not a hero", () => {
    const entered = render(createElement(ChapterOpening, { arrived: true }));
    expect(entered).toMatch(/<h2 data-story-line="title" class="story-enter [^"]*text-\[clamp\(2rem,5\.4vw,4\.4rem\)\]/);
    expect(entered).not.toMatch(/<h1[\s>]/);
  });

  it("waits on the first frame of its rise until the film is in view", () => {
    const waiting = render(createElement(ChapterOpening, { arrived: false }));
    expect(waiting).toContain('data-film-chapter="waiting"');
    expect(waiting).not.toContain("story-enter");
    expect(waiting.match(/opacity:0;transform:translateY\(28px\)/g)).toHaveLength(2);
    expect(waiting).toContain("scaleX(0)");
  });

  it("is what the film draws too, in place of the poster and both credit blocks", () => {
    const source = readFileSync("components/story/LandingStory.tsx", "utf8");
    expect(source).toMatch(/<Caption cue=\{table\.beat\.opening\} fade=\{table\.fade\}>\s*<ChapterOpening arrived=\{arrived\} \/>\s*<\/Caption>/);
    expect(source).not.toContain("HeroCredits");
  });

  it("plays the stated cut's beats, and falls back to the classic cut's", () => {
    expect(storyCut(data)).toBe("stated");
    expect(storyCut({ ...data, statement: null })).toBe("classic");
  });
});

describe("the chapter cut's closing card", () => {
  it("offers Make one to the studio first, with no prefetch, and Verify an image second", () => {
    const markup = render(createElement(CloseCard, { data }));
    const calls = asked.filter((link) => link.href !== "/docs/proof");
    expect(calls).toEqual([
      { href: "/studio", prefetch: false, words: en.home.first.make },
      { href: "/verify", prefetch: undefined, words: en.story.close.verify },
    ]);
    expect(en.home.first.make).toBe("Make one");
    expect(en.story.close.verify).toBe("Verify an image");
    expect(markup).not.toContain(RETIRED.register);
    expect(text(markup)).toContain(en.story.close.title);
    expect(text(markup)).toContain(en.story.close.body);
  });

  it("splits into the words and the counts on a laptop, and stacks them on a phone", () => {
    const markup = render(createElement(CloseCard, { data }));
    expect(markup).toContain('data-close-card="chapter"');
    expect(markup).toMatch(/data-close-card="chapter" class="[^"]* lg:grid lg:grid-cols-/);
    const text0 = markup.indexOf('data-close-half="text"');
    const figures = markup.indexOf('data-close-half="figures"');
    expect(text0).toBeGreaterThan(-1);
    expect(figures).toBeGreaterThan(text0);
    // The counts are the index's own totals, at display size from 1024 px.
    const half = markup.slice(figures);
    expect(half).toContain(">41</dd>");
    expect(half).toContain(">20</dd>");
    expect(half).toMatch(/lg:text-\[clamp\(5rem,9\.5vw,10rem\)\]/);
  });

  it("says unread rather than inventing a count", () => {
    const markup = render(createElement(CloseCard, { data: { ...data, passportCount: null } }));
    expect(markup).toContain(`>${en.story.close.unread}</dd>`);
  });

  it("fades the film's tail into the page on a phone, only while pinned", () => {
    expect(render(createElement(CloseCard, { data }))).toContain("data-close-fade");
    expect(render(createElement(CloseCard, { data, pinned: false }))).not.toContain("data-close-fade");
  });
});

describe("the chapter cut's light header", () => {
  it("keeps the light header rule to the chapter cut alone", () => {
    const source = readFileSync("components/story/LandingStory.tsx", "utf8");
    const look = source.slice(source.indexOf("const CHAPTER_LOOK"), source.indexOf("`;", source.indexOf("const CHAPTER_LOOK")));
    const selectors = look.split("\n").filter((line) => line.trim().endsWith("{"));
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) {
      expect(selector).toContain(':has([data-story-cut="chapter"])');
    }
    expect(source).toContain("data-story-cut={variant}");
  });
});

describe("the chapter's words", () => {
  it("are in all ten message files, under the same keys as English", () => {
    const english = Object.keys(en.story.chapter).sort();
    expect(english).toEqual(["kicker", "title"]);
    for (const locale of LOCALES) {
      const messages = JSON.parse(readFileSync(`messages/${locale}.json`, "utf8")) as {
        story: { chapter?: Record<string, unknown> };
      };
      const chapter = messages.story.chapter;
      expect(chapter, locale).toBeDefined();
      expect(Object.keys(chapter ?? {}).sort(), locale).toEqual(english);
      for (const key of english) {
        const said = chapter?.[key];
        expect(typeof said === "string" && said.trim().length > 0, `${locale} story.chapter.${key}`).toBe(true);
        if (locale !== "en") {
          expect(said, `${locale} story.chapter.${key} is still English`).not.toBe(
            en.story.chapter[key as keyof typeof en.story.chapter],
          );
        }
      }
    }
  });

  it("left the English-only file behind", () => {
    expect(() => readFileSync("components/story/chapter.ts", "utf8")).toThrow();
  });
});

describe("the home page", () => {
  beforeEach(() => {
    reads.story.mockReset().mockResolvedValue(data);
    reads.first.mockReset().mockResolvedValue({ finding: null, copy: null, samples: [], loose: null });
  });

  const page = async (locale: string, messages: unknown) =>
    render(await HomePage({ params: Promise.resolve({ locale }) }), locale, messages);

  /** The film's own markup, from the stage down: the board above it is a stand-in here. */
  const stage = (html: string) => html.slice(html.indexOf('data-stage="chapter"'));

  it("asks for the chapter cut, under the first screen", async () => {
    const markup = await page("en", en);
    expect(markup).toContain('<section data-board="true"></section><div data-gate="true"><div data-stage="chapter">');
    expect(readFileSync("app/[locale]/page.tsx", "utf8")).toContain('variant="chapter"');
  });

  it("renders the chapter opening on /en, with no MOOLAM title and no opening buttons", async () => {
    const markup = await page("en", en);
    expect(markup).toContain('data-film-chapter="entered"');
    expect(text(opening(stage(markup)))).toBe(`${en.story.chapter.kicker} ${en.story.chapter.title}`);
    const headings = markers(markup).headings;
    expect(headings[0]).toBe(en.story.chapter.title);
    expect(headings).not.toContain(en.story.title);
    expect(markup).not.toContain(RETIRED.line);
    expect(markup).not.toContain(RETIRED.credit);
    expect(markup).not.toContain(RETIRED.generate);
    expect(markup).not.toContain(RETIRED.verify);
    expect(markup).not.toContain("mode=generate");
    expect(markup).not.toContain("data-film-opening");
    // The page's one h1 is the first screen's, which the board draws.
    expect(markup).not.toMatch(/<h1[\s>]/);
  });

  it("ends on the page's one final call", async () => {
    const markup = await page("en", en);
    expect(markup).toContain('data-close-card="chapter"');
    expect(asked.filter((link) => link.href === "/studio")).toEqual([
      { href: "/studio", prefetch: false, words: en.home.first.make },
    ]);
  });

  it("says the chapter in Tamil on /ta", async () => {
    const markup = await page("ta", ta);
    expect(text(opening(stage(markup)))).toBe(`${ta.story.chapter.kicker} ${ta.story.chapter.title}`);
    expect(markers(markup).headings).not.toContain(ta.story.title);
    expect(markup).not.toContain(RETIRED.generateTa);
  });
});
