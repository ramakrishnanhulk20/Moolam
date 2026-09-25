// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useRef, type FunctionComponent, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";
import { OPENING_AT, filmArrived } from "@/components/story/signals";

/**
 * The film under the first screen: its title is not the page's h1, its opening
 * plays when it comes into view rather than when it is mounted, and its second
 * beat is called Signed, so the word sealed is left to a picture never published.
 */

// The film carries the site's own links, which need a router this test has none of.
vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown }) => createElement("a", { href: props.href }, props.children as never),
  useRouter: () => ({ refresh: () => undefined }),
  usePathname: () => "/",
}));

const { useFilmArrived } = await import("@/components/story/LandingStory");
const { ChapterOpening } = await import("@/components/story/ChapterOpening");

function render(node: ReactElement): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;
  return renderToStaticMarkup(createElement(Provider, { locale: "en", messages: en, timeZone: "UTC" }, node));
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LOCALES = ["en", "ta", "hi", "zh", "ja", "ko", "es", "fr", "de", "pt"] as const;

const roots: Root[] = [];

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) {
      root.unmount();
    }
  });
  document.body.innerHTML = "";
});

async function frames(count = 3) {
  for (let at = 0; at < count; at += 1) {
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    });
  }
}

describe("the film's title", () => {
  it("is an h2 in the film and on the still page, at the size of the beats after it", () => {
    const markup = render(createElement(ChapterOpening, { arrived: true }));
    expect(markup).not.toMatch(/<h1[\s>]/);
    expect(markup).toMatch(/<h2 data-story-line="title" class="story-enter mt-5 [^"]*text-\[clamp\(2rem,5\.4vw,4\.4rem\)\][^"]*"[^>]*>/);
    expect(markup).toContain(`>${en.story.chapter.title}</h2>`);
    for (const file of ["components/story/LandingStory.tsx", "components/story/StillStory.tsx"]) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/<h1[\s>]/);
    }
  });
});

describe("the film's opening entrance", () => {
  it("waits on its first frame until the film is in view, then rises", () => {
    const waiting = render(createElement(ChapterOpening, { arrived: false }));
    expect(waiting).not.toContain("story-enter");
    expect(waiting.match(/opacity:0;transform:translateY\(28px\)/g)?.length).toBe(2);

    const entered = render(createElement(ChapterOpening, { arrived: true }));
    expect(entered.match(/class="story-enter /g)?.length).toBe(2);
    expect(entered).not.toContain("opacity:0");
  });

  it("counts the film as in view once most of the window is film", () => {
    const room = 812;
    expect(filmArrived(room, room)).toBe(false);
    expect(filmArrived(room * 0.5, room)).toBe(false);
    expect(filmArrived(room * (1 - OPENING_AT), room)).toBe(true);
    expect(filmArrived(0, room)).toBe(true);
    expect(filmArrived(-400, room)).toBe(true);
  });

  it("starts when the film enters the viewport, not when it is mounted under the first screen", async () => {
    const box = { top: 900 };
    const seen: boolean[] = [];

    function Film(): ReactNode {
      const stage = useRef<HTMLDivElement>(null);
      const arrived = useFilmArrived(stage, true);
      seen.push(arrived);
      return createElement("div", {
        ref: (node: HTMLDivElement | null) => {
          stage.current = node;
          if (node !== null) {
            node.getBoundingClientRect = () => ({ top: box.top }) as DOMRect;
          }
        },
        "data-arrived": String(arrived),
      });
    }

    Object.defineProperty(window, "innerHeight", { configurable: true, value: 812 });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => root.render(createElement(Film)));

    // Mounted a screen below, as the first scroll mounts it: nothing plays.
    await frames();
    expect(host.firstElementChild?.getAttribute("data-arrived")).toBe("false");
    box.top = 500;
    await frames();
    expect(host.firstElementChild?.getAttribute("data-arrived")).toBe("false");

    // Most of the window is film now.
    box.top = 200;
    await frames();
    expect(host.firstElementChild?.getAttribute("data-arrived")).toBe("true");

    // And it stays played if the reader scrolls back up.
    box.top = 900;
    await frames();
    expect(host.firstElementChild?.getAttribute("data-arrived")).toBe("true");
    expect(seen.lastIndexOf(false)).toBeLessThan(seen.indexOf(true));
  });
});

describe("the film's signing beat", () => {
  /** What each language called the beat before it was renamed on 2026-09-25. */
  const WAS: Record<(typeof LOCALES)[number], string> = {
    en: "Sealed",
    ta: "முத்திரையானது",
    hi: "मुहरबंद",
    zh: "封存",
    ja: "封をする",
    ko: "봉인",
    es: "Sellada",
    fr: "Scellée",
    de: "Versiegelt",
    pt: "Selada",
  };

  type Messages = {
    story: { sealed: Record<string, string> };
    explore: { sealed: { word: string } };
    passport: { sealed: { label: string } };
    studio: { sealed: { plate: { sealed: string } } };
  };

  const read = (locale: string): Messages => JSON.parse(readFileSync(`messages/${locale}.json`, "utf8")) as Messages;

  for (const locale of LOCALES) {
    it(`says signed, and never sealed, in ${locale}`, () => {
      const messages = read(locale);
      // The words this language uses for a picture never published, which the
      // signing beat must not borrow.
      const sealedWords = new Set([
        WAS[locale],
        messages.explore.sealed.word,
        messages.passport.sealed.label,
        messages.studio.sealed.plate.sealed,
      ]);
      for (const [key, line] of Object.entries(messages.story.sealed)) {
        for (const word of sealedWords) {
          expect(line.toLowerCase(), `story.sealed.${key}`).not.toContain(word.toLowerCase());
        }
        if (locale === "en") {
          expect(line, `story.sealed.${key}`).not.toMatch(/seal/i);
        }
      }
      expect(messages.story.sealed.kicker).not.toBe(WAS[locale]);
    });
  }

  it("leaves sealed where it means a picture never published", () => {
    const en = read("en");
    expect(en.story.sealed.kicker).toBe("Signed");
    expect(en.explore.sealed.word).toBe("Sealed");
    expect(en.passport.sealed.label).toBe("Sealed");
  });
});
