import { readFileSync } from "node:fs";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import en from "@/messages/en.json";
import type { StoryData } from "@/components/story/data";

/**
 * The film told as a chapter under the home page's first screen, on the lab
 * page before it goes anywhere else.
 *
 * What is held here: the chapter cut opens on a chapter title with no poster
 * and no buttons, its last card's first call is named as on the first screen,
 * the stated cut the home page plays still opens and closes exactly as it did,
 * and the lab route is closed without the lab flag.
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

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

vi.mock("next-intl/server", () => ({ setRequestLocale: () => undefined }));

// The lab page's reads and heavy parts, answered here. What the page is held
// to is which cut it asks for and that it asks for nothing without the flag.
vi.mock("@/components/story/data", () => ({ heldStory: reads.story }));
vi.mock("@/components/home/read", () => ({ firstScreenData: reads.first }));
vi.mock("@/components/home/Board", () => ({ Board: () => createElement("section", { "data-board": true }) }));
vi.mock("@/components/guide/FirstVisitGuide", () => ({ FirstVisitGuide: () => null }));
vi.mock("@/components/home/FilmGate", () => ({
  FilmGate: (props: { children?: unknown }) => createElement("div", { "data-gate": true }, props.children as never),
}));
vi.mock("@/components/story/StoryStage", () => ({
  StoryStage: (props: { variant?: string }) => createElement("div", { "data-stage": props.variant }),
}));

const { LandingStory } = await import("@/components/story/LandingStory");
const { CloseCard } = await import("@/components/story/CloseCard");
const { ChapterOpening } = await import("@/components/story/ChapterOpening");
const { CHAPTER_WORDS } = await import("@/components/story/chapter");
const { beatTable } = await import("@/components/story/beats");
const { storyCut } = await import("@/components/story/stated");
const { default: HomeChapterLabPage } = await import("@/app/[locale]/lab/home-chapter/page");

function render(node: ReactElement): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;
  return renderToStaticMarkup(createElement(Provider, { locale: "en", messages: en, timeZone: "UTC" }, node));
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
    expect(text(first)).toBe(`${CHAPTER_WORDS.kicker} ${CHAPTER_WORDS.title}`);
    expect(first).not.toContain("<a ");
    expect(film).not.toContain(`>${en.story.title}</h2>`);
    expect(film).not.toContain(en.story.line);
    expect(film).not.toContain(en.story.kicker);
    expect(film).not.toContain(en.home.hero.credit);
    expect(film).not.toContain(en.home.hero.generate);
    expect(film).not.toContain("mode=generate");
  });

  it("is a chapter heading at the size of the beats after it, not a hero", () => {
    const entered = renderToStaticMarkup(createElement(ChapterOpening, { arrived: true }));
    expect(entered).toMatch(/<h2 data-story-line="title" class="story-enter [^"]*text-\[clamp\(2rem,5\.4vw,4\.4rem\)\]/);
    expect(entered).not.toMatch(/<h1[\s>]/);
  });

  it("waits on the first frame of its rise until the film is in view", () => {
    const waiting = renderToStaticMarkup(createElement(ChapterOpening, { arrived: false }));
    expect(waiting).toContain('data-film-chapter="waiting"');
    expect(waiting).not.toContain("story-enter");
    expect(waiting.match(/opacity:0;transform:translateY\(28px\)/g)).toHaveLength(2);
    expect(waiting).toContain("scaleX(0)");
  });

  it("is what the film draws too, in place of the poster and both credit blocks", () => {
    const source = readFileSync("components/story/LandingStory.tsx", "utf8");
    expect(source).toMatch(/chapter \? \(\s*<Caption cue=\{table\.beat\.opening\} fade=\{table\.fade\}>\s*<ChapterOpening arrived=\{arrived\} \/>\s*<\/Caption>/);
  });

  it("plays the stated cut's beats, and falls back with it", () => {
    expect(beatTable("chapter")).toBe(beatTable("stated"));
    expect(storyCut("chapter", data)).toBe("stated");
    expect(storyCut("chapter", { ...data, statement: null })).toBe("classic");
    expect(storyCut("stated", data)).toBe("stated");
    expect(storyCut("classic", data)).toBe("classic");
  });
});

describe("the chapter cut's closing card", () => {
  it("offers Make one to the studio first, with no prefetch, and Verify an image second", () => {
    const markup = render(createElement(CloseCard, { data, chapter: true }));
    const calls = asked.filter((link) => link.href !== "/docs/proof");
    expect(calls).toEqual([
      { href: "/studio", prefetch: false, words: en.home.first.make },
      { href: "/verify", prefetch: undefined, words: en.story.close.verify },
    ]);
    expect(en.home.first.make).toBe("Make one");
    expect(en.story.close.verify).toBe("Verify an image");
    expect(markup).not.toContain(en.story.close.register);
    expect(text(markup)).toContain(en.story.close.title);
    expect(text(markup)).toContain(en.story.close.body);
  });

  it("splits into the words and the counts on a laptop, and stacks them on a phone", () => {
    const markup = render(createElement(CloseCard, { data, chapter: true }));
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
    const markup = render(createElement(CloseCard, { data: { ...data, passportCount: null }, chapter: true }));
    expect(markup).toContain(`>${en.story.close.unread}</dd>`);
  });

  it("fades the film's tail into the page on a phone, only while pinned", () => {
    expect(render(createElement(CloseCard, { data, chapter: true }))).toContain("data-close-fade");
    expect(render(createElement(CloseCard, { data, chapter: true, pinned: false }))).not.toContain("data-close-fade");
  });
});

describe("the stated cut the home page plays", () => {
  it("opens on the poster and its two calls, as it did", () => {
    const film = render(createElement(LandingStory, { data, variant: "stated" as const }));
    expect(markers(opening(film))).toEqual({
      headings: [en.story.title],
      links: [`/studio?mode=generate ${en.home.hero.generate} →`, `/verify ${en.home.hero.verify}`],
    });
    expect(text(opening(film))).toContain(en.story.kicker);
    expect(text(opening(film))).toContain(en.story.line);
    expect(film).not.toContain("data-film-chapter");
    expect(film).not.toContain(CHAPTER_WORDS.title);
  });

  it("closes on the card it always had", () => {
    const card = render(createElement(CloseCard, { data }));
    expect(markers(card)).toEqual({
      headings: [en.story.close.title],
      links: [`/studio ${en.story.close.register} →`, `/verify ${en.story.close.verify}`, `/docs/proof ${en.story.close.proof}`],
    });
    expect(card).not.toContain("data-close-card");
    expect(card).not.toContain("data-close-half");
    expect(card).not.toContain("data-close-fade");
    expect(card).not.toContain("lg:grid");
  });

  it("keeps the light header rule to the chapter cut alone", () => {
    const source = readFileSync("components/story/LandingStory.tsx", "utf8");
    const look = source.slice(source.indexOf("const CHAPTER_LOOK"), source.indexOf("`;", source.indexOf("const CHAPTER_LOOK")));
    const selectors = look.split("\n").filter((line) => line.trim().endsWith("{"));
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) {
      expect(selector).toContain(':has([data-story-cut="chapter"])');
    }
    expect(source).toContain('data-story-cut={chapter ? "chapter" : undefined}');
  });

  it("is still what the home page asks for", () => {
    const page = readFileSync("app/[locale]/page.tsx", "utf8");
    expect(page).toContain('variant="stated"');
    expect(page).not.toContain("chapter");
  });
});

describe("the lab page", () => {
  beforeEach(() => {
    reads.story.mockReset().mockResolvedValue(data);
    reads.first.mockReset().mockResolvedValue({ finding: null, copy: null, samples: [], loose: null });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const page = () => HomeChapterLabPage({ params: Promise.resolve({ locale: "en" }) });

  it("is a 404 without the lab flag, before anything is read", async () => {
    vi.stubEnv("NEXT_PUBLIC_LAB_PAGES", "");
    await expect(page()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(reads.story).not.toHaveBeenCalled();
    expect(reads.first).not.toHaveBeenCalled();
  });

  it("draws the first screen, then the film as a chapter under it", async () => {
    vi.stubEnv("NEXT_PUBLIC_LAB_PAGES", "1");
    const markup = renderToStaticMarkup(await page());
    expect(markup).toMatch(/<section data-board="true"><\/section><div data-gate="true"><div data-stage="chapter"><\/div><\/div>/);
  });

  it("is linked from the lab index", () => {
    expect(readFileSync("app/[locale]/lab/page.tsx", "utf8")).toContain('href="/lab/home-chapter"');
  });
});
