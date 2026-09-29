import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";
import type { Consent } from "@/lib/chain/consent";

/**
 * What the proof walk of 29 September still found open in the frame: the grey
 * static square on the phone film, the stated beat's date off the left of a
 * phone, the language switch that blanked the page and slid the tab bar in
 * again, the language list past the right edge, Back after a jump landing on
 * the jumped-to section, the evidence board dropping when an answer lands, the
 * Copy link label that sat in from its line and shifted, and the one footer
 * link not set in capitals.
 */

vi.mock("@/lib/i18n/routing", () => ({
  routing: { locales: ["en", "ta", "hi", "zh", "ja", "ko", "es", "fr", "de", "pt"], defaultLocale: "en" },
  localeLabels: {
    en: "English",
    ta: "தமிழ்",
    hi: "हिन्दी",
    zh: "简体中文",
    ja: "日本語",
    ko: "한국어",
    es: "Español",
    fr: "Français",
    de: "Deutsch",
    pt: "Português",
  },
  usePathname: () => "/passport/0x1",
  useRouter: () => ({ replace: () => undefined, prefetch: () => undefined, refresh: () => undefined }),
  Link: (props: { href: string; className?: string; children?: ReactNode }) =>
    createElement("a", { href: props.href, className: props.className }, props.children),
}));
vi.mock("next/navigation", () => ({ useParams: () => ({ locale: "en" }) }));
vi.mock("@/components/passport/Picture", () => ({
  Picture: (props: { alt?: string }) => createElement("span", { "data-picture": props.alt ?? "" }),
}));

const source = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");

function render(node: ReactElement): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
    children?: ReactNode;
  }>;
  return renderToStaticMarkup(createElement(Provider, { locale: "en", messages: en, timeZone: "UTC" }, node));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the focal plate on the film (step 2)", async () => {
  const { focalInks } = await import("@/components/story/scene/field");

  it("never draws the grey static on a phone, and shows the picture from the moment the plate comes in", () => {
    for (const [entry, made] of [
      [0.4, 0],
      [1, 0],
      [1, 0.1],
      [1, 0.3],
    ]) {
      const phone = focalInks({ entry, made, swapped: 0, pictured: true, phone: true });
      expect(phone.grain).toBe(0);
      expect(phone.picture).toBeGreaterThan(0);
    }
    // The made beat still develops it to full strength over the same stretch as the laptop's.
    expect(focalInks({ entry: 1, made: 0, swapped: 0, pictured: true, phone: true }).picture).toBeCloseTo(0.4, 6);
    expect(focalInks({ entry: 1, made: 0.8, swapped: 0, pictured: true, phone: true }).picture).toBeCloseTo(1, 6);
  });

  it("shows nothing on a plate whose picture has not arrived, on either screen", () => {
    for (const phone of [true, false]) {
      expect(focalInks({ entry: 1, made: 0.9, swapped: 0, pictured: false, phone }).picture).toBe(0);
    }
    expect(focalInks({ entry: 1, made: 0, swapped: 0, pictured: false, phone: true }).grain).toBe(0);
  });

  it("leaves the laptop film exactly as it was", () => {
    for (const [entry, made] of [
      [0.5, 0],
      [1, 0.2],
      [1, 0.5],
      [1, 0.9],
    ]) {
      const laptop = focalInks({ entry, made, swapped: 0.3, pictured: true, phone: false });
      expect(laptop.grain).toBeCloseTo(entry * Math.max(0, 1 - made * 1.5), 9);
      expect(laptop.picture).toBeCloseTo(entry * Math.min(1, Math.max(0, (made - 0.35) / 0.45)) * 0.7, 9);
    }
  });
});

describe("the stated beat's written day on a phone (step 3)", async () => {
  const { InlineLedger, writtenShift } = await import("@/components/story/StatedLedger");
  const CLOSED: Consent = {
    aiTraining: "notAllowed",
    aiGenerativeTraining: "notAllowed",
    aiInference: "notAllowed",
    dataMining: "notAllowed",
  };

  it("starts at a notch near the rule's start, ends at one near its end, and centres on the rest", () => {
    expect(writtenShift(0)).toBe("translateX(0)");
    expect(writtenShift(0.1)).toBe("translateX(0)");
    expect(writtenShift(0.5)).toBe("translateX(-50%)");
    expect(writtenShift(0.9)).toBe("translateX(-100%)");
  });

  it("draws a statement written on the registration day from the notch inward", () => {
    const view = { consent: CLOSED, dated: true, notch: 0, registered: "Sep 27, 2026", writtenShort: "Sep 27, 2026" };
    const markup = render(createElement(InlineLedger, { view }));
    expect(markup).toMatch(/style="transform:translateX\(0\)">Sep 27, 2026</);
    expect(markup).not.toContain("translateX(-50%)");
  });
});

describe("the language switch (step 4)", async () => {
  const { barEntrance, markBarEntered, BottomBar } = await import("@/components/shell/BottomBar");
  const { switchOnItsWay, otherLocales, shouldWarmLanguages } = await import("@/components/LocaleSwitch");
  const { openingEntrance } = await import("@/app/[locale]/loading");
  const tabs = [
    { key: "home" as const, href: "/", label: "Home" },
    { key: "explore" as const, href: "/explore", label: "Explore" },
  ];

  it("slides the tab bar in on its first mount in a tab and never again", () => {
    expect(barEntrance(false, false)).toEqual({ opacity: 0, y: 56 });
    expect(barEntrance(false, true)).toEqual({ opacity: 0 });
    expect(barEntrance(true, false)).toBe(false);
    expect(barEntrance(true, true)).toBe(false);

    const first = render(createElement(BottomBar, { tabs, label: "Places" }));
    expect(first).toContain("translateY(56px)");
    markBarEntered();
    const again = render(createElement(BottomBar, { tabs, label: "Places" }));
    expect(again).not.toContain("translateY(56px)");
    expect(again).not.toMatch(/<nav[^>]*opacity:0/);
  });

  it("fetches this page in every other language when the list opens, unless the reader saves data", () => {
    expect(otherLocales("en")).toEqual(["ta", "hi", "zh", "ja", "ko", "es", "fr", "de", "pt"]);
    expect(otherLocales("ta")).not.toContain("ta");
    expect(shouldWarmLanguages(undefined)).toBe(true);
    expect(shouldWarmLanguages({ saveData: false })).toBe(true);
    expect(shouldWarmLanguages({ saveData: true })).toBe(false);
    const code = source("components/LocaleSwitch.tsx");
    expect(code).toContain("router.prefetch(pathname, { locale });");
    // A built page comes whole with the default kind; "full" would draw nine pages on the server per open.
    expect(code).not.toMatch(/kind: "full"|PrefetchKind/);
    expect(code).toContain("switchPressedAt = performance.now();");
    expect(code).toMatch(/if \(locale === active\) return;\s+markSwitchPressed\(\);/);
  });

  it("holds the loading screen back longer when it stands in for a switch, so a fast one never flashes it", () => {
    expect(switchOnItsWay()).toBe(false);
    const press = openingEntrance(false, false);
    const swap = openingEntrance(true, false);
    expect(press.transition.delay).toBeCloseTo(0.14, 6);
    expect(swap.transition.delay).toBeGreaterThanOrEqual(0.6);
    expect(swap.initial).toEqual({ opacity: 0, y: 8 });
    // Under reduced motion nothing moves, but a switch still waits before the words appear.
    expect(openingEntrance(false, true).initial).toBe(false);
    expect(openingEntrance(true, true)).toEqual({ initial: { opacity: 0 }, transition: { delay: swap.transition.delay, duration: 0 } });
  });
});

describe("the phone language list (step 5)", () => {
  it("hangs from the chip's end edge on every width and is capped to the window", () => {
    const code = source("components/LocaleSwitch.tsx");
    const list = code.slice(code.indexOf("<motion.ul"), code.indexOf("</motion.ul>"));
    expect(list).toContain('className="absolute end-0 ');
    expect(list).toContain("max-w-[calc(100vw-2.5rem)]");
    expect(list).not.toMatch(/\bstart-0\b/);
    expect(list).not.toContain("sm:end-0");
    expect(list).not.toContain("second row");
  });
});

describe("Back after a jump (step 6)", async () => {
  const { addressOnlyHistory, FactJumpLink } = await import("@/components/passport/FactJump");

  it("writes the page's own address, fragment and all cleared, with the router's state", () => {
    const state = { __NA: true };
    const history = { state, replaceState: vi.fn() };
    const jump = addressOnlyHistory(history as unknown as History, { pathname: "/en/passport/0x1", search: "?from=verify" });
    expect(jump.state).toBe(state);
    jump.replaceState(jump.state, "", "#made-by");
    expect(history.replaceState).toHaveBeenCalledWith(state, "", "/en/passport/0x1?from=verify");
  });

  it("leaves no fragment on the entry after a plain click, and still jumps", () => {
    const target = { scrollIntoView: vi.fn(), focus: vi.fn(), hasAttribute: () => false, setAttribute: vi.fn() };
    const history = { state: { __NA: true }, replaceState: vi.fn(), pushState: vi.fn() };
    vi.stubGlobal("document", { getElementById: (id: string) => (id === "made-by" ? target : null) });
    vi.stubGlobal("window", {
      history,
      location: { pathname: "/en/passport/0x1", search: "", hash: "#ai-use" },
      matchMedia: () => ({ matches: false }),
    });
    const link = FactJumpLink({ href: "#made-by", children: "Made by" });
    const event = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false, preventDefault: vi.fn() };
    (link.props as { onClick: (event: unknown) => void }).onClick(event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(target.scrollIntoView).toHaveBeenCalled();
    expect(history.replaceState).toHaveBeenCalledWith(history.state, "", "/en/passport/0x1");
    expect(history.pushState).not.toHaveBeenCalled();
    // The link itself still carries the section, for a middle click and a shared link.
    expect((link.props as { href: string }).href).toBe("#made-by");
  });
});

describe("the evidence board when an answer lands (step 7)", async () => {
  const { Board, BOARD_SPREAD } = await import("@/components/home/Board");

  it("spreads the board over the first screen only, not over a row an answer has grown", () => {
    const code = source("components/home/Board.tsx");
    // The row is at least the first screen and the panel pads it by 2.5svh top and bottom.
    expect(code).toContain("min-h-[calc(100svh-var(--header-h))]");
    expect(code).toContain("lg:py-[2.5svh]");
    expect(BOARD_SPREAD).toBe("lg:min-h-[calc(95svh-var(--header-h))]");

    const markup = render(
      createElement(Board, { finding: { failed: "index" }, copy: { failed: "index" }, samples: [], loose: null }),
    );
    const spread = markup.match(/<div data-board-spread="true" class="([^"]*)"/);
    expect(spread?.[1]).toContain("justify-between");
    expect(spread?.[1]).toContain(BOARD_SPREAD);
    // The panel around it no longer spreads anything over the full row.
    const panel = markup.slice(0, markup.indexOf("data-board-spread")).split("<div").pop() ?? "";
    expect(panel).not.toContain("justify-between");
  });
});

describe("Copy link on both posters (step 8)", async () => {
  const { ShareLink } = await import("@/components/passport/ShareLink");

  it("starts both labels at the line's start edge, so the words never move when they change", () => {
    const markup = render(createElement(ShareLink, { words: { copy: "Copy link", copied: "Link copied", copyFailed: "No" } }));
    const button = markup.match(/<button[^>]*data-copy-link[^>]*class="([^"]*)"/);
    expect(button?.[1]).toContain("inline-grid");
    expect(button?.[1]).toContain("justify-items-start");
    expect(button?.[1]).toContain("text-start");
  });
});

describe("the footer's Show the guide again (step 9)", () => {
  it("is set in capitals like the links beside it", () => {
    const layout = source("app/[locale]/layout.tsx");
    expect(layout).toContain('<ShowGuideAgain label={g("again")} className={`${FOOTER_ROW} uppercase`} />');
  });
});
