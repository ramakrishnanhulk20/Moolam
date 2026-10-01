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
 * The film's roll-ins and the fixes that ride with them.
 *
 * 03B was the framed dark screen on the light page; the story roll-in (WO-279c)
 * replaced it: the film is light by default and runs edge to edge on the
 * page's own Linen, its chapter title inside the shot. 04A: on a phone the tab
 * bar stays through the whole film, the shot fills the room between the header
 * and the bar, and the words stand just above the bar. With them: the bar
 * keeps its rule with less motion, the film's refusal red is the site's, the
 * film's loading box is the chapter's first frame, and the ladder counts bits.
 * The film's rules live in its own room.ts now, so that is what is read.
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

const { FilmLoading } = await import("@/components/story/FilmLoading");
const { FilmGate } = await import("@/components/home/FilmGate");
const { BottomBar } = await import("@/components/shell/BottomBar");
const { REFUSED, VERIFIED } = await import("@/components/story/palette");
const { phoneShot, LandingStory } = await import("@/components/story/LandingStory");
const { bitsApart, degradeSteps } = await import("@/components/story/measurements");
const { FILM_STYLE } = await import("@/components/story/room");

const css = FILM_STYLE;
const site = readFileSync("styles/globals.css", "utf8");

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
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

describe("the film on the light page, edge to edge", () => {
  const gate = render(createElement(FilmGate, null, createElement("div", null, "film")));

  it("is no longer framed: no frame, no title above a screen, the title inside the shot", () => {
    expect(gate).not.toContain("story-frame");
    expect(gate).toContain('data-film="loading"');
    expect(gate).toMatch(/<p[^>]*>How a picture gets its passport<\/p>/);
  });

  it("is the page's own Linen with no theme class at all, and the shipped film only under the dark class", () => {
    expect(css).toMatch(/html\.dark \[data-film-room\] \{\s*--bg: #0b0b0c;/);
    // Nothing in the film's rules is keyed to "not light", which is also a page with no script.
    expect(css).not.toContain(":not(.light)");
    const loading = render(createElement(FilmLoading));
    expect(loading).toContain("data-film-room");
    expect(loading).not.toContain('class="story"');
  });

  it("never wears the old dark-whatever-the-theme class", () => {
    for (const file of ["components/story/StoryStage.tsx", "components/home/FilmGate.tsx", "components/story/LandingStory.tsx"]) {
      expect(readFileSync(file, "utf8"), file).not.toContain('className="story"');
    }
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

  it("leaves no rule for the old black film, which nothing renders (WO-279f)", () => {
    const header = readFileSync("components/shell/PhoneHeader.tsx", "utf8");
    const css = readFileSync("styles/globals.css", "utf8");
    expect(header).not.toContain("[data-story]");
    for (const gone of [".story-stage", ".story .grain", ".story-lower", "story-close"]) {
      expect(css).not.toContain(gone);
    }
  });

  it("keeps the rule over the active tab with less motion, so colour is not the only sign (F33)", () => {
    for (const reduced of [false, true]) {
      const markup = bar(reduced);
      const home = markup.slice(markup.indexOf('data-tab="home"'), markup.indexOf('data-tab="explore"'));
      expect(home, `reduced ${reduced}`).toContain("data-lit");
      expect(markup.match(/data-lit/g), `reduced ${reduced}`).toHaveLength(1);
    }
  });

  it("stops the words and every panel at the phone's whole bottom room", () => {
    const lower = rule(".film-lower");
    expect(lower).toContain("top: var(--film-top);");
    expect(lower).toContain("bottom: var(--film-words-foot);");
    expect(lower).toContain("align-items: flex-end;");
    const phone = inMedia("(max-width: 767px)", "[data-film-room]");
    expect(phone).toContain("--film-words-foot: var(--bar-room);");
    expect(phone).toContain("--film-foot: calc(56px + max(env(safe-area-inset-bottom), var(--bar-safe, 0px)));");
    expect(rule("[data-film-room]")).toContain("--film-top: var(--header-h);");
    // --bar-room is the tab bar and the menu's two sides together, set by the layout.
    expect(site).toContain("--bar-room:");
    expect(inMedia("(min-width: 640px)", ".film-lower")).toContain("padding-bottom: var(--film-words-foot);");
    expect(rule(".film-cue")).toContain("bottom: calc(var(--film-words-foot) + 1.75rem);");
    // Every caption, the drop panel and the closing card stand in that room.
    expect(readFileSync("components/story/LandingStory.tsx", "utf8")).toContain('className="film-lower pointer-events-none');
    expect(readFileSync("components/story/TryPanel.tsx", "utf8")).toContain('"film-lower pointer-events-none');
    expect(readFileSync("components/story/CloseCard.tsx", "utf8")).toContain('"film-close film-lower pointer-events-none');
  });

  it("stands each beat's words on a fade of the room's own ground, rising from the bar", () => {
    const fade = inMedia("(max-width: 639px)", ".film-lower > :last-child::before");
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

  it("draws the whole shot when nothing covers the canvas", () => {
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
  const story = rule("html.dark [data-film-room]");

  it("refuses in the dark room in the site's own dark failure red", () => {
    expect(story).toContain(`--status-failed: ${REFUSED.toLowerCase()};`);
    expect(REFUSED.toLowerCase()).toBe("#ff5f4d");
  });

  it("matches in the site's own teal", () => {
    expect(story).toContain(`--status-verified: ${VERIFIED.toLowerCase()};`);
  });
});

describe("F2: the film's box while its code is on its way", () => {
  it("is the chapter's first frame on the room's own ground, at the film's height", () => {
    const markup = render(createElement(FilmLoading));
    expect(markup).toMatch(
      /<div data-film-room="true" class="grain relative h-\[100svh\] w-full overflow-hidden bg-bg" data-film="loading">/,
    );
    expect(text(markup)).toBe(`${en.story.chapter.kicker} ${en.story.chapter.title}`);
    expect(markup).toContain('data-beat="opening"');
    expect(markup).not.toMatch(/style="[^"]*opacity:\s*0/);
  });

  it("is what the gate holds open before the film is asked for", () => {
    const markup = render(createElement(FilmGate, null, createElement("div", null, "film")));
    expect(markup).toContain("data-film-gate");
    const box = markup.slice(markup.indexOf('data-film="loading"'));
    expect(text(box)).toContain(en.story.chapter.title);
  });

  it("is what the film's own loader draws too", () => {
    const stage = readFileSync("components/story/StoryStage.tsx", "utf8");
    expect(stage).toContain("loading: () => <FilmLoading />");
  });

  it("leaves the footer in place while it waits", () => {
    expect(css).not.toContain('body:has([data-film="loading"]) footer');
    expect(css).toContain('body:has([data-film="film"]):not([data-story-end]) footer');
  });
});

describe("F25: the found beat counts bits, as its caption says", () => {
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

  it("lands on the last copy's figure as bits, big figure and caption alike, and never a confidence", () => {
    // Without a browser the film draws its still page, where the copy is home.
    const markup = render(createElement(LandingStory, { data, variant: "chapter" as const }));
    const steps = degradeSteps();
    const last = steps[steps.length - 1];
    const said = en.story.verified.similarity
      .replace("{value}", bitsApart(last))
      .replace("{result}", en.story.verified.match);
    expect(said).toBe(`${last.phashDistance} of 64 bits apart: match`);
    expect(last.transform).toBe("resize-10");
    expect(markup).toContain(`>${said}</span>`);
    // Ink on Linen, the film's pink in the dark room.
    expect(markup).toContain(`tabular-nums text-text [html.dark_&amp;]:text-accent">${bitsApart(last)}</span>`);
    expect(markup).not.toMatch(/\d\.\d\d of 64 bits apart/);
    const film = readFileSync("components/story/LandingStory.tsx", "utf8");
    expect(film).not.toContain("confidence.toFixed(2)");
  });
});
