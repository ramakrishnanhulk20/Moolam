import { readFileSync } from "node:fs";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import en from "@/messages/en.json";
import degrade from "@/public/hero/degrade.json";
import type { StoryData } from "@/components/story/data";
import type { Tab } from "@/components/shell/tabs";

/**
 * The film's two roll-ins from the polish lab, and the fixes that ride with
 * them.
 *
 * 03B: under the light theme the film is a framed dark screen on the cream
 * page, its title above it. 04A: on a phone the tab bar stays through the whole
 * film, the shot fills the room between the header and the bar, and the words
 * stand just above the bar. With them: the bar keeps its rule with less motion,
 * the film's refusal red is the site's, the film's loading box is the chapter's
 * first frame rather than a black window, and the ladder counts bits.
 */

const motion = vi.hoisted(() => ({ reduced: false }));

vi.mock("@/components/motion/useIsReducedMotion", () => ({ useIsReducedMotion: () => motion.reduced }));

vi.mock("@/lib/i18n/routing", () => ({
  Link: ({ href, children, ...rest }: Record<string, unknown> & { href: unknown; children?: unknown }) => {
    delete rest.prefetch;
    return createElement("a", { href: typeof href === "string" ? href : "/", ...rest }, children as never);
  },
  useRouter: () => ({ refresh: () => undefined }),
  usePathname: () => "/",
}));

const { FilmFrame } = await import("@/components/story/FilmFrame");
const { FilmLoading } = await import("@/components/story/FilmLoading");
const { FilmGate } = await import("@/components/home/FilmGate");
const { BottomBar } = await import("@/components/shell/BottomBar");
const { REFUSED, VERIFIED } = await import("@/components/story/palette");
const { phoneShot, LandingStory } = await import("@/components/story/LandingStory");
const { bitsApart, degradeSteps } = await import("@/components/story/measurements");

const css = readFileSync("styles/globals.css", "utf8");

function render(node: ReactElement): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;
  return renderToStaticMarkup(createElement(Provider, { locale: "en", messages: en, timeZone: "UTC" }, node));
}

/** One rule's body, by its exact selector line. */
function rule(selector: string, from = 0): string {
  const at = css.indexOf(`${selector} {`, from);
  expect(at, selector).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("}", at));
}

/** The body of the first media block with this exact query that holds the given selector. */
function inMedia(query: string, selector: string): string {
  let at = css.indexOf(`@media ${query} {`);
  while (at > -1) {
    const body = css.slice(at, css.indexOf("\n}\n", at));
    if (body.includes(`${selector} {`)) {
      return rule(selector, at);
    }
    at = css.indexOf(`@media ${query} {`, at + 1);
  }
  throw new Error(`no ${selector} under @media ${query}`);
}

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

describe("03B: the film as a framed dark screen on the light page", () => {
  const markup = render(createElement(FilmFrame, null, createElement("div", { className: "story" }, "film")));

  it("wraps the film in the frame and puts the chapter title above it, on the page", () => {
    expect(markup).toMatch(/^<section class="story-frame" data-story-frame="true">/);
    const title = markup.indexOf("story-frame-title");
    expect(title).toBeGreaterThan(-1);
    expect(title).toBeLessThan(markup.indexOf('class="story"'));
    expect(text(markup.slice(title, markup.indexOf('class="story"')))).toContain(
      `${en.story.chapter.kicker} ${en.story.chapter.title}`,
    );
    expect(markup).toMatch(/<h2[^>]*>How a picture gets its passport<\/h2>/);
  });

  it("never hides the title behind an opacity only a script would lift", () => {
    expect(markup).not.toMatch(/style="[^"]*opacity:\s*0/);
    expect(markup).toMatch(/class="story-frame-title rise /);
  });

  it("frames it in the light theme alone: 32 px of page, 16 on a phone, 8 px corners and a hairline", () => {
    expect(rule(".story-frame-title")).toContain("display: none;");
    const frame = rule("html.light .story-frame");
    expect(frame).toContain("--frame-gap: 32px;");
    expect(frame).toContain("padding-inline: var(--frame-gap);");
    expect(inMedia("(max-width: 767px)", "html.light .story-frame")).toContain("--frame-gap: 16px;");
    const screen = rule("html.light .story-frame > .story");
    expect(screen).toContain("border: 1px solid var(--frame-line);");
    expect(screen).toContain("border-radius: 8px;");
    expect(screen).toContain("overflow: clip;");
    expect(rule("html.light .story-frame-title")).toContain("display: block;");
  });

  it("sizes the screen to what the window leaves once the page is at the film's foot, so the pin still fills it", () => {
    const height = rule('html.light .story-frame [data-story="film"],\nhtml.light .story-frame [data-story="loading"]');
    expect(height).toContain("100svh - var(--header-h) - var(--frame-gap) * 2 - var(--frame-foot)");
    expect(inMedia("(max-width: 767px)", "html.light .story-frame")).toContain("--frame-foot: var(--bar-room);");
  });

  it("draws the title once: above the screen in the light theme, inside the shot in the dark", () => {
    expect(rule('html.light .story-frame [data-beat="opening"]')).toContain("display: none;");
  });

  it("leaves the header on the page's cream over the framed film", () => {
    const film = readFileSync("components/story/LandingStory.tsx", "utf8");
    expect(film).not.toContain("CHAPTER_LOOK");
  });

  it("hands the still page's closing card back to cream the way the film's is (F38)", () => {
    const still = '.light [data-story="still"] > div > section:last-child';
    expect(css).toContain(`.light,\n.light .story-close,\n${still} {\n  --bg: #e4ddd0;`);
    const ground = rule(still, css.indexOf("/* The still page ends on the same card"));
    expect(ground).toContain("background: var(--bg);");
    expect(ground).toContain("color-scheme: light;");
  });
});

describe("04A: the tab bar through the film on a phone", () => {
  const TABS: Tab[] = [
    { key: "home", href: "/", label: "Home" },
    { key: "explore", href: "/explore", label: "Explore" },
    { key: "make", href: "/studio", label: "Make", prefetch: false },
    { key: "verify", href: "/verify", label: "Verify" },
    { key: "mine", href: "/mine", label: "Mine" },
  ];
  const bar = (reduced: boolean) => {
    motion.reduced = reduced;
    const Bar = BottomBar as unknown as FunctionComponent<{ tabs: Tab[]; label: string; shape: "raised"; at: string }>;
    return renderToStaticMarkup(createElement(Bar, { tabs: TABS, label: "Sections", shape: "raised", at: "/" }));
  };

  it("renders on the film's own route with all five tabs and Home marked as the page", () => {
    const markup = bar(false);
    expect([...markup.matchAll(/data-tab="([a-z]+)"/g)].map((found) => found[1])).toEqual([
      "home",
      "explore",
      "make",
      "verify",
      "mine",
    ]);
    expect(markup).toMatch(/aria-current="page"[^>]*data-tab="home"/);
    expect(markup).not.toContain("inert");
  });

  it("no longer watches the film to hide itself or take itself out of reach", () => {
    const source = readFileSync("components/shell/BottomBar.tsx", "utf8");
    expect(source).not.toContain("barLook");
    expect(source).not.toContain("filmShare");
    expect(source).not.toContain('[data-story="film"]');
    expect(source).not.toContain("progress.close");
    expect(source).not.toContain(".inert");
    expect(source).not.toContain("requestAnimationFrame");
  });

  it("keeps the rule over the active tab with less motion, so colour is not the only sign (F33)", () => {
    for (const reduced of [false, true]) {
      const markup = bar(reduced);
      const home = markup.slice(markup.indexOf('data-tab="home"'), markup.indexOf('data-tab="explore"'));
      expect(home, `reduced ${reduced}`).toContain("data-lit");
      expect(markup.match(/data-lit/g), `reduced ${reduced}`).toHaveLength(1);
    }
  });

  it("stops the words and every panel at the bar's whole room, the raised Make included", () => {
    const lower = rule(".story-lower");
    expect(lower).toContain("top: var(--film-top);");
    expect(lower).toContain("bottom: var(--film-words-foot);");
    expect(lower).toContain("align-items: flex-end;");
    const phone = inMedia("(max-width: 767px)", ".story");
    expect(phone).toContain("--film-words-foot: var(--bar-room);");
    expect(phone).toContain("--film-foot: calc(56px + max(env(safe-area-inset-bottom), var(--bar-safe, 0px)));");
    expect(css).toContain("\n.story {\n  --film-top: var(--header-h);\n  --film-foot: 0px;\n  --film-words-foot: 0px;\n}");
    expect(css).toContain("--bar-room: calc(84px + env(safe-area-inset-bottom));");
    expect(inMedia("(min-width: 640px)", ".story-lower")).toContain("padding-bottom: var(--film-words-foot);");
    expect(rule(".story-cue")).toContain("bottom: calc(var(--film-words-foot) + 1.75rem);");
  });

  it("stands each beat's words on a dark fade of its own, rising from the bar", () => {
    const fade = inMedia("(max-width: 639px)", ".story-lower > :last-child::before");
    expect(fade).toContain("z-index: -1;");
    expect(fade).toMatch(/linear-gradient\(\s*0deg,\s*var\(--bg\) 0%/);
  });

  it("registers the two lengths the renderer reads, so they come back in pixels", () => {
    expect(css).toMatch(/@property --film-top \{\s*syntax: "<length>";/);
    expect(css).toMatch(/@property --film-foot \{\s*syntax: "<length>";/);
    const film = readFileSync("components/story/LandingStory.tsx", "utf8");
    expect(film).toContain('style.getPropertyValue("--film-top")');
    expect(film).toContain('style.getPropertyValue("--film-foot")');
  });

  it("fills the room between the header and the bar with the shot, its aim a little above the middle", () => {
    const canvas = { width: 375, height: 812 };
    const room = { top: 56, foot: 56 };
    const shot = phoneShot(canvas, room, 0.45);
    const inside = canvas.height - room.top - room.foot;
    // Drawn from the bar's top, and reaching past the header.
    expect(shot.y).toBe(room.foot);
    expect(shot.y + shot.height).toBeGreaterThanOrEqual(canvas.height - room.top);
    // The middle of the drawn rectangle, measured down from the top of the room.
    const aim = canvas.height - room.top - (shot.y + shot.height / 2);
    expect(aim / inside).toBeCloseTo(0.32, 2);
    // A lens a little wider than the old band's, and never a fish eye.
    expect(shot.fov).toBeGreaterThan(54);
    expect(shot.fov).toBeLessThanOrEqual(80.1);
  });

  it("draws the whole framed screen under the light theme, which already sits between the header and the bar", () => {
    const shot = phoneShot({ width: 343, height: 640 }, { top: 0, foot: 0 }, 0.45);
    expect(shot.y).toBe(0);
    expect(shot.y + shot.height).toBeGreaterThanOrEqual(640);
  });

  it("keeps a phone's thumb travel per beat what it was", () => {
    const film = readFileSync("components/story/LandingStory.tsx", "utf8");
    expect(film).toContain("const PHONE_TRAVEL = 0.45;");
    expect(film).toContain("const SHORT_PHONE_TRAVEL = 0.36;");
    expect(film).toContain("<ScrollControls pages={table.pages} distance={travel} damping={0.22}>");
  });
});

describe("the film's status colours", () => {
  const story = rule(".story");

  it("refuses in the site's own failure red (the film is dark in both themes)", () => {
    expect(story).toContain(`--status-failed: ${REFUSED.toLowerCase()};`);
    expect(REFUSED.toLowerCase()).toBe("#ff5f4d");
  });

  it("matches in the site's own teal", () => {
    expect(story).toContain(`--status-verified: ${VERIFIED.toLowerCase()};`);
  });
});

describe("F2: the film's box while its code is on its way", () => {
  it("is the chapter's first frame on the film's dark ground, at the film's height", () => {
    const markup = render(createElement(FilmLoading));
    expect(markup).toMatch(/<div class="grain relative h-\[100svh\] w-full overflow-hidden bg-bg" data-story="loading">/);
    expect(text(markup)).toBe(`${en.story.chapter.kicker} ${en.story.chapter.title}`);
    expect(markup).toContain('data-beat="opening"');
    expect(markup).not.toMatch(/style="[^"]*opacity:\s*0/);
  });

  it("is what the gate holds open before the film is asked for, inside the frame", () => {
    const markup = render(createElement(FilmGate, null, createElement("div", null, "film")));
    expect(markup).toContain("data-film-gate");
    const box = markup.slice(markup.indexOf('data-story="loading"'));
    expect(text(box)).toContain(en.story.chapter.title);
    expect(markup.indexOf("story-frame")).toBeLessThan(markup.indexOf("data-film-gate"));
  });

  it("is what the film's own loader draws too", () => {
    const stage = readFileSync("components/story/StoryStage.tsx", "utf8");
    expect(stage).toContain("loading: () => <FilmLoading />");
  });

  it("leaves the footer in place while it waits", () => {
    expect(css).not.toContain('body:has([data-story="loading"]) footer');
  });
});

describe("F25: the verified beat counts bits, as its caption says", () => {
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
    statement: null,
    statementError: null,
    passportCount: 41,
    attestationCount: 20,
    error: null,
  };

  it("reads each rung's distance off degrade.json's own fingerprint measurement", () => {
    for (const step of degradeSteps()) {
      const measured = degrade.steps.find((entry) => entry.transform === step.transform);
      expect(bitsApart(step), step.transform).toBe(String(measured?.phashDistance));
    }
  });

  it("draws the first rung as bits, big figure and caption alike, and never a confidence", () => {
    // Without a browser the film draws its still page, which carries the same beat.
    const markup = render(createElement(LandingStory, { data, variant: "chapter" as const }));
    const first = degradeSteps()[0];
    const said = en.story.verified.similarity
      .replace("{value}", bitsApart(first))
      .replace("{result}", en.story.verified.match);
    expect(said).toBe("0 of 64 bits apart: match");
    expect(markup).toContain(`>${said}</span>`);
    expect(markup).toMatch(new RegExp(`tabular-nums text-accent">${bitsApart(first)}</span>`));
    expect(markup).not.toMatch(/\d\.\d\d of 64 bits apart/);
    const film = readFileSync("components/story/LandingStory.tsx", "utf8");
    expect(film).not.toContain("confidence.toFixed(2)");
  });
});
