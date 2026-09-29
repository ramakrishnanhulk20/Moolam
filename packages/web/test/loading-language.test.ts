import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";

/**
 * A press that opens a page shows it is opening, a language change says which
 * language is on its way and fades the page rather than blanking it, and the
 * two failure pages answer a press.
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
  usePathname: () => "/verify",
  useRouter: () => ({ replace: () => undefined }),
  Link: (props: { href: string; className?: string; children?: ReactNode }) =>
    createElement("a", { href: props.href, className: props.className }, props.children),
}));
vi.mock("next/navigation", () => ({ useParams: () => ({ locale: "en" }) }));
vi.mock("next/link", () => ({
  default: (props: { href: string; className?: string; children?: ReactNode }) =>
    createElement("a", { href: props.href, className: props.className }, props.children),
}));
vi.mock("next/script", () => ({
  default: (props: { id: string }) => createElement("template", { "data-script": props.id }),
}));
vi.mock("@/lib/fonts", () => ({ fontVariables: "fonts" }));

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

describe("the screen a press shows while its page is on the way", () => {
  it("stands in for every page a press opens, in that page's own shape, with a seal that holds still under reduced motion", async () => {
    const routes: Array<[string, string, () => Promise<{ default: FunctionComponent }>]> = [
      ["general", "page", () => import("@/components/shell/Opening")],
      ["passport", "poster", () => import("@/app/[locale]/passport/[id]/loading")],
      ["agent", "agent", () => import("@/app/[locale]/agent/[id]/loading")],
      ["studio", "page", () => import("@/app/[locale]/studio/loading")],
      ["mine", "page", () => import("@/app/[locale]/mine/loading")],
      ["explore view", "explore", () => import("@/app/[locale]/explore/view/loading")],
    ];
    for (const [route, frame, load] of routes) {
      const { default: Loading } = await load();
      const markup = render(createElement(Loading));
      expect(markup, route).toContain(en.common.openingPage);
      expect(markup, route).toContain(`data-opening="${frame}"`);
      expect(markup, route).toContain('role="status"');
      expect(markup, route).toContain('aria-busy="true"');
      expect(markup, route).toMatch(/class="motif [^"]*animate-pulse motion-reduce:animate-none/);
      expect(markup, route).toContain("min-h-[70vh]");
    }

    // The poster frames are the exact heights of the posters they stand in for.
    const { default: Opening } = (await import("@/components/shell/Opening")) as {
      default: FunctionComponent<{ frame?: string }>;
    };
    const passport = "h-[74svh] min-h-[34rem] sm:h-[min(78vh,46rem)]";
    const poster = source("components/passport/Poster.tsx");
    for (const size of passport.split(" ")) expect(poster).toContain(size);
    expect(render(createElement(Opening, { frame: "poster" }))).toContain(passport);
    expect(source("components/agent/AgentPoster.tsx")).toContain("min-h-[30rem] w-full");
    expect(render(createElement(Opening, { frame: "agent" }))).toContain("min-h-[30rem] sm:min-h-[38rem]");
  });
});

describe("the language switch", () => {
  it("names the language on its way, fades the page to 60 percent and back, walks with the arrows and has 44 px rows", async () => {
    const { OpeningNote, dimFrame, stepOption, LocaleSwitch } = await import("@/components/LocaleSwitch");

    const note = render(createElement(OpeningNote, { language: "தமிழ்", reduced: false }));
    expect(note).toContain(en.header.languageOpening.replace("{language}", "தமிழ்"));
    expect(note).toMatch(/class="motif [^"]*animate-pulse motion-reduce:animate-none/);

    type Part = { style: { opacity: string; transition: string } };
    const parts: Part[] = [{ style: { opacity: "", transition: "" } }, { style: { opacity: "1", transition: "" } }];
    let asked = "";
    const root = {
      querySelectorAll: (selector: string) => {
        asked = selector;
        return parts;
      },
    } as unknown as ParentNode;
    const undo = dimFrame(root, false);
    expect(asked).toBe("main, main ~ footer");
    expect(parts.map((part) => part.style.opacity)).toEqual(["0.6", "0.6"]);
    expect(parts[0].style.transition).toContain("opacity");
    undo();
    expect(parts.map((part) => part.style.opacity)).toEqual(["", "1"]);
    const still = dimFrame(root, true);
    expect(parts[0].style.transition).toBe("none");
    still();

    expect(stepOption(0, "ArrowDown", 10)).toBe(1);
    expect(stepOption(9, "ArrowDown", 10)).toBe(0);
    expect(stepOption(0, "ArrowUp", 10)).toBe(9);
    expect(stepOption(4, "Home", 10)).toBe(0);
    expect(stepOption(4, "End", 10)).toBe(9);
    expect(stepOption(4, "Tab", 10)).toBeNull();

    // At rest the chip names the current language, holds a live region ready
    // for the sentence, and is never disabled, so a keyboard press keeps focus.
    const chip = render(createElement(LocaleSwitch));
    expect(chip).toContain("English");
    expect(chip).toContain('role="status"');
    expect(chip).not.toMatch(/ disabled=""/);
    expect(chip).toContain('aria-disabled="false"');

    const code = source("components/LocaleSwitch.tsx");
    expect(code).toContain("group flex min-h-11 w-full");
    expect(code).toContain("tabIndex={current ? 0 : -1}");
    expect(code).toContain("if (inside) chip.current?.focus();");
    expect(code).toContain("!event.currentTarget.contains(next)) setOpen(false)");
  });
});

describe("the laptop theme chip", () => {
  it("never cuts its label, in any language", async () => {
    vi.doMock("next-themes", () => ({ useTheme: () => ({ setTheme: () => undefined }) }));
    const { ThemeToggle } = await import("@/components/ThemeToggle");
    const markup = render(createElement(ThemeToggle));
    expect(markup).toContain(en.header.themeDark);
    expect(markup).toContain(en.header.themeLight);
    expect(markup).not.toContain("max-w-[14ch]");
    expect(markup).not.toContain("truncate");
    expect(markup).toContain("whitespace-nowrap");
  });
});

describe("the error and not-found pages", () => {
  it("send a bare address to the reader's language, reach 44 px, and say when a try failed again", async () => {
    const { default: RootNotFound } = await import("@/app/not-found");
    const root = renderToStaticMarkup(createElement(RootNotFound));
    const script = /<script>([\s\S]*?)<\/script>/.exec(root)?.[1] ?? "";
    expect(script.length).toBeGreaterThan(0);

    const run = (pathname: string, languages: string[], visibility = "") => {
      let went: string | null = null;
      const html = { style: { visibility } };
      new Function("location", "navigator", "document", script)(
        { pathname, search: "?a=1", hash: "", replace: (to: string) => (went = to) },
        { languages, language: languages[0] },
        { documentElement: html },
      );
      return { went, hidden: html.style.visibility === "hidden" };
    };
    expect(run("/verify", ["ta-IN", "en"])).toEqual({ went: "/ta/verify?a=1", hidden: true });
    expect(run("/studio", ["it-IT", "pt-BR"]).went).toBe("/pt/studio?a=1");
    expect(run("/verify", ["it"]).went).toBe("/en/verify?a=1");
    expect(run("/en/nothing-here", ["ta"]).went).toBeNull();
    expect(run("/api/nothing", ["ta"]).went).toBeNull();
    // The second copy of the line stands down once the first has sent the reader on.
    expect(run("/verify", ["ta"], "hidden").went).toBeNull();
    expect(root).toContain('data-script="language-redirect"');

    expect(root).toMatch(/<a href="\/en\/verify" class="inline-flex min-h-11 items-center/);
    const { default: LocaleNotFound } = await import("@/app/[locale]/not-found");
    expect(source("app/[locale]/not-found.tsx")).toContain('className="inline-flex min-h-11 items-center rounded-[8px]');
    expect(typeof LocaleNotFound).toBe("function");

    const { default: LocaleError, noteTry, failedAfterTry } = await import("@/app/[locale]/error");
    const props = { error: new Error("x"), reset: () => undefined };
    const first = render(createElement(LocaleError, props));
    expect(first).toMatch(/<button type="button" aria-busy="false" class="inline-flex min-h-11 items-center/);
    expect(first).toContain(`>${en.error.retry}</button>`);
    expect(first).not.toContain("data-tried-again");
    expect(first).not.toContain(en.retry.stopped);

    const now = Date.now();
    noteTry("", now);
    expect(failedAfterTry("", now + 1_000)).toBe(true);
    expect(failedAfterTry("/other", now + 1_000)).toBe(false);
    expect(failedAfterTry("", now + 31_000)).toBe(false);
    const again = render(createElement(LocaleError, props));
    expect(again).toContain("data-tried-again");
    expect(again).toContain(en.retry.stopped);
  });
});
