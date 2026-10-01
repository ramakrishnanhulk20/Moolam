import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";

/**
 * The quality gaps the launch audit of 2026-09-21 measured on the live site.
 *
 * Every check here is one of its rows: what a link pasted into a chat carries,
 * what a screen reader hears when it reaches a registered picture, what a thumb
 * can hit, and whether the words exist in all ten languages. The numbers that
 * need a real browser, tap sizes, the fold and the film's caption band, are
 * measured outside this file, in a real browser.
 */

/** Where the mocked router says the reader is. Each test sets it before rendering. */
const here = vi.hoisted(() => ({ locale: "ta", path: "/" }));

// next-intl's navigation helpers reach for next/navigation, which only resolves
// inside the bundler, so the whole module is stood in for. The locale list and
// the labels are the real ones, checked against the message files below.
vi.mock("@/lib/i18n/routing", () => ({
  routing: {
    locales: ["en", "ta", "hi", "zh", "ja", "ko", "es", "fr", "de", "pt"],
    defaultLocale: "en",
  },
  localeLabels: {
    en: "English",
    ta: "தமிழ்",
    hi: "Hindi",
    zh: "Chinese",
    ja: "Japanese",
    ko: "Korean",
    es: "Espanol",
    fr: "Francais",
    de: "Deutsch",
    pt: "Portugues",
  },
  usePathname: () => here.path,
  useRouter: () => ({ replace: () => undefined, push: () => undefined }),
  Link: (props: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ locale: here.locale }),
  usePathname: () => here.path,
  useRouter: () => ({ replace: () => undefined, push: () => undefined }),
  notFound: () => {
    throw new Error("not found");
  },
  redirect: () => undefined,
}));

const MESSAGES = fileURLToPath(new URL("../messages/", import.meta.url));
const locales = readdirSync(MESSAGES)
  .filter((name) => name.endsWith(".json"))
  .map((name) => name.replace(".json", ""));

type Tree = Record<string, unknown>;

function read(locale: string): Tree {
  return JSON.parse(readFileSync(`${MESSAGES}${locale}.json`, "utf8")) as Tree;
}

function at(tree: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => (node as Tree | undefined)?.[key], tree);
}

const files = new Map(locales.map((locale) => [locale, read(locale)]));

/** The keys this order added or rewrote. Every one of them is wanted in all ten. */
const TOUCHED = [
  "meta.home",
  "studio.lede",
  "explore.lede",
  "resolve.lede",
  "common.registeredPicture",
  "docs.diagramNamed",
  "docs.diagramNamedFull",
  "header.languageIs",
  "header.themeDarkAction",
  "header.themeLightAction",
];

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
}

describe("the launch polish copy, counted in every language", () => {
  it("has all ten files", () => {
    expect(locales).toHaveLength(10);
  });

  for (const key of TOUCHED) {
    it(`says ${key} in ten languages`, () => {
      const said = locales.filter((locale) => {
        const value = at(files.get(locale), key);
        return typeof value === "string" && value.trim().length > 0;
      });
      expect(said.length, `${key}: ${said.join(" ")}`).toBe(10);
    });
  }

  it("keeps the placeholders every translated line needs", () => {
    for (const locale of locales) {
      expect(String(at(files.get(locale), "header.languageIs")), locale).toContain("{language}");
      expect(String(at(files.get(locale), "docs.diagramNamed")), locale).toContain("{name}");
      expect(String(at(files.get(locale), "docs.diagramNamedFull")), locale).toContain("{name}");
    }
  });
});

describe("what a search result and a link preview carry", () => {
  it("gives the home page a description that says what Moolam is and names Monad", () => {
    for (const locale of locales) {
      const line = String(at(files.get(locale), "meta.home"));
      // The audit found 28 characters in English, which is a poster line and
      // not a description. The cap is what a search result shows before it
      // starts cutting; the floor is what the audit called "short".
      expect([...line].length, `${locale} meta.home`).toBeGreaterThan(50);
      expect([...line].length, `${locale} meta.home`).toBeLessThanOrEqual(155);
      expect(line, `${locale} meta.home`).toContain("Monad");
    }
  });

  it("keeps the four page descriptions inside what a result will show", () => {
    for (const locale of locales) {
      for (const key of ["studio.lede", "explore.lede", "resolve.lede"]) {
        expect([...String(at(files.get(locale), key))].length, `${locale} ${key}`).toBeLessThanOrEqual(160);
      }
    }
  });

  it("never lets a docs description stop mid-word", async () => {
    const { openingLines } = await import("@/app/[locale]/docs/[[...slug]]/page");
    const long =
      "Moolam gives every generated picture a passport on Monad the moment it is made. " +
      "The passport carries the fingerprint, the creator and the agent that signed it, and anyone can check a copy against it later.";

    const cut = openingLines(long);
    expect(cut.length).toBeLessThanOrEqual(155);
    expect(cut.endsWith("Mon")).toBe(false);
    // It stops at the end of a sentence when one fits, so it reads finished.
    expect(cut).toBe("Moolam gives every generated picture a passport on Monad the moment it is made.");
    // A first sentence longer than the budget still stops at a whole word.
    const oneSentence = `${"word ".repeat(60)}end.`;
    const word = openingLines(oneSentence);
    expect(word.length).toBeLessThanOrEqual(155);
    expect(word.endsWith("...")).toBe(true);
    expect(word.replace("...", "").endsWith("wor")).toBe(false);
    // Importing the docs page pulls its markdown and highlighter in, which alone
    // passes 5 s when the whole suite shares the machine.
  }, 15_000);

  it("cuts a passport's description at a whole word inside the budget", async () => {
    const { shortDescription } = await import("@/app/[locale]/passport/[id]/opengraph-image");
    const lead = "The holder said this picture is open to AI use, written on 12 September 2026.";
    const long = `${lead} ${"A long pinned description that carries on well past what any preview will show. ".repeat(4)}`;

    const cut = shortDescription(long);
    expect(cut.length).toBeLessThanOrEqual(160);
    // The lead is the part that matters, so it survives whole.
    expect(cut.startsWith(lead)).toBe(true);
    expect(cut.endsWith("...")).toBe(true);
    expect(shortDescription(lead)).toBe(lead);
  });
});

describe("the ten addresses every page answers at", () => {
  it("walks three routes and links all ten languages plus x-default on each", async () => {
    const routes = ["/", "/explore", "/passport/0xabc"];
    const { PageAddress } = await import("@/components/LocaleSwitch");
    for (const route of routes) {
      here.locale = "ta";
      here.path = route;
      const markup = renderToStaticMarkup(
        createElement(PageAddress as FunctionComponent<Record<string, string>>, {
          site: "https://moolam.vercel.app",
          ogLocale: "ta_IN",
          siteName: "Moolam",
        }),
      );

      const tail = route === "/" ? "" : route;
      for (const locale of locales) {
        expect(markup, `${route} ${locale}`).toContain(
          `<link rel="alternate" hrefLang="${locale}" href="https://moolam.vercel.app/${locale}${tail}"/>`,
        );
      }
      expect(markup, route).toContain(
        `<link rel="alternate" hrefLang="x-default" href="https://moolam.vercel.app/en${tail}"/>`,
      );
      expect(markup, route).toContain(`<meta property="og:url" content="https://moolam.vercel.app/ta${tail}"/>`);
      expect(markup, route).toContain('<meta property="og:locale" content="ta_IN"/>');
      expect(markup, route).toContain('<meta property="og:site_name" content="Moolam"/>');
    }
    here.path = "/";
  });

  it("asks Next for the canonical of whatever page is being drawn", () => {
    const layout = source("app/[locale]/layout.tsx");
    expect(layout).toContain('alternates: { canonical: "./" }');
    // An openGraph block at this level would replace the one Next builds from
    // the card file, which is how the picture fell out of every link preview.
    expect(layout).not.toContain("openGraph:");
  });
});

describe("the page a wrong address lands on", () => {
  it("carries its own title and description, not the site's", async () => {
    for (const locale of locales) {
      vi.resetModules();
      vi.doMock("next-intl/server", () => ({
        getTranslations: async ({ locale: asked }: { locale: string }) =>
          (key: string) => String(at(files.get(asked), `notFound.${key}`)),
      }));
      const { generateMetadata } = await import("@/app/[locale]/[...missing]/layout");
      const meta = await generateMetadata({ params: Promise.resolve({ locale }) });
      expect(meta.title, locale).toEqual({ absolute: String(at(files.get(locale), "notFound.title")) });
      expect(meta.description, locale).toBe(String(at(files.get(locale), "notFound.lede")));
      expect(meta.description, locale).not.toBe(String(at(files.get(locale), "meta.description")));
    }
    vi.doUnmock("next-intl/server");
    vi.resetModules();
  });
});

describe("the favicon, the manifest and the phone bar", () => {
  it("answers /favicon.ico with a real icon file carrying three sizes", () => {
    const file = readFileSync(fileURLToPath(new URL("../public/favicon.ico", import.meta.url)));
    expect(file.readUInt16LE(0)).toBe(0);
    expect(file.readUInt16LE(2)).toBe(1);
    const count = file.readUInt16LE(4);
    expect(count).toBe(3);
    const sizes = Array.from({ length: count }, (_, index) => file.readUInt8(6 + index * 16));
    expect(sizes).toEqual([16, 32, 48]);
    for (let index = 0; index < count; index += 1) {
      const offset = file.readUInt32LE(6 + index * 16 + 12);
      const length = file.readUInt32LE(6 + index * 16 + 8);
      expect(file.toString("ascii", offset + 1, offset + 4), `size ${sizes[index]}`).toBe("PNG");
      expect(offset + length).toBeLessThanOrEqual(file.length);
    }
  });

  it("names the app, its colours and its icons for a home screen", async () => {
    const { default: manifest } = await import("@/app/manifest");
    const made = manifest();
    expect(made.short_name).toBe("Moolam");
    expect(made.name).toContain("Moolam");
    expect(made.description).toBe(en.meta.home);
    expect(made.start_url).toBe("/en");
    expect(made.display).toBe("standalone");
    expect(made.theme_color).toBe("#08080a");
    expect(made.background_color).toBe("#08080a");
    expect(made.icons?.map((icon) => icon.src)).toEqual(["/icon.svg", "/apple-icon.png", "/favicon.ico"]);
  });

  it("paints the phone bar in the light palette every first visit gets", () => {
    const layout = source("app/[locale]/layout.tsx");
    expect(layout).toContain('themeColor: "#e4ddd0"');
    expect(layout).not.toContain("prefers-color-scheme");
    // Both values are the palette's own --bg, so the bar and the page agree:
    // the head carries the light one, and ThemeColor swaps in the dark one.
    const css = source("styles/globals.css");
    expect(css).toContain("--bg: #08080a");
    expect(css).toContain("--bg: #e4ddd0");
  });
});

describe("the controls a screen reader and a voice can reach", () => {
  it("puts the visible word inside the name of the language and theme chips", () => {
    for (const locale of locales) {
      const tree = files.get(locale);
      const dark = String(at(tree, "header.themeDark"));
      const light = String(at(tree, "header.themeLight"));
      expect(String(at(tree, "header.themeDarkAction")), `${locale} dark`).toContain(dark);
      expect(String(at(tree, "header.themeLightAction")), `${locale} light`).toContain(light);
    }
    // The language chip shows the language's own name, which is the same in
    // every file, so the name is built around it at render time.
    expect(source("components/LocaleSwitch.tsx")).toContain('t("languageIs", { language: localeLabels[');
    expect(source("components/ThemeToggle.tsx")).toContain('aria-label={t("themeDarkAction")}');
  });

  it("hangs the 44 px pad on the header nav and the two chips", () => {
    // The links are drawn by HeaderNav, where every one of them shares one class list.
    const nav = source("components/shell/HeaderNav.tsx");
    expect(nav).toContain("className: `tap whitespace-nowrap");
    expect(nav.match(/className: `tap /g)).toHaveLength(1);
    const layout = source("app/[locale]/layout.tsx");
    expect(layout).toMatch(/className="tap-row [^"]*md:flex[^"]*"/);
    const chips = layout.slice(layout.indexOf('className="tap-row '), layout.indexOf("</div>", layout.indexOf('className="tap-row ')));
    expect(chips).toContain("<LocaleSwitch />");
    expect(chips).toContain("<ThemeToggle />");
  });

  it("takes the film's canvas out of the way and leaves its words in the page", () => {
    const story = source("components/story/LandingStory.tsx");
    expect(story).toContain('gl.domElement.setAttribute("aria-hidden", "true")');
    // The beats are real text in the document whether or not their beat is the
    // one on screen, which is what a screen reader reads instead of the shot.
    expect(story).toContain("data-beat={cue.name}");
  });
});

describe("the one contrast failure the audit found", () => {
  it("darkens the light theme's code keyword until it clears 4.5 to 1", () => {
    const css = source("styles/globals.css");
    // The keyword takes the light palette's accent, which clears the bar on the
    // code block's ground since the accent was darkened for the sunken wells.
    expect(css).toMatch(/span\[style\*="--shiki-light:#D73A49" i\] \{\n {2}color: var\(--accent\);/);
    const from = css.indexOf(".light,\n");
    const light = css.slice(from, css.indexOf("\n}", from));
    const keyword = /--accent:\s*(#[0-9a-f]{6})/i.exec(light)?.[1];
    expect(keyword).toBeDefined();

    const channel = (value: number) => {
      const part = value / 255;
      return part <= 0.03928 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    // The docs code block's ground in the light palette.
    const ratio = (luminance("#d8d0c1") + 0.05) / (luminance(keyword as string) + 0.05);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
    // The red github-light ships, for the record: the audit measured 3.54 on the
    // old paper, and on Linen it is 2.99.
    expect((luminance("#d8d0c1") + 0.05) / (luminance("#d73a49") + 0.05)).toBeLessThan(4.5);
  });
});

describe("a picture a visitor can hear", () => {
  it("carries the registered title, and falls back to a translated name", async () => {
    vi.resetModules();
    vi.doMock("next/image", () => ({
      default: (props: { src: string; alt?: string }) =>
        createElement("img", { src: String(props.src), alt: props.alt ?? "" }),
    }));
    vi.doMock("@/lib/images", () => ({
      pictureSources: (url: string) => [url],
      isOptimizable: () => true,
      nextSource: () => null,
    }));

    const { Plate } = await import("@/components/explore/Plate");
    const plate = {
      id: `0x${"11".repeat(32)}`,
      title: "Monsoon Fishing Nets Drying",
      kind: 0,
      registeredAt: 1_789_038_756,
      thumbnailUrl: "https://gateway.example/one.jpg",
      manifest: true,
      rechecked: true,
      disputed: false,
      chainlink: false,
      consent: null,
    };

    const named = render(createElement(Plate as FunctionComponent<{ plate: unknown }>, { plate }));
    expect(named).toContain('alt="Monsoon Fishing Nets Drying"');
    expect(named).not.toContain('alt=""');

    const unnamed = render(
      createElement(Plate as FunctionComponent<{ plate: unknown }>, { plate: { ...plate, title: null } }),
    );
    expect(unnamed).toContain(`alt="${en.common.registeredPicture}"`);

    vi.doUnmock("next/image");
    vi.doUnmock("@/lib/images");
    vi.resetModules();
  });

  it("is passed by every grid that draws a registered picture", () => {
    for (const path of [
      "components/passport/Poster.tsx",
      "components/agent/Works.tsx",
      "components/verify/Samples.tsx",
      "components/studio/YourPassports.tsx",
    ]) {
      expect(source(path), path).toMatch(/alt=\{\w+(\.\w+)*\.title \?\? common\("registeredPicture"\)\}/);
    }
    // The picture itself keeps an empty default, for the one wall of repeated
    // thumbnails behind the agent heading that really is decoration.
    expect(source("components/passport/Picture.tsx")).toContain('alt = ""');
    expect(source("components/agent/AgentPoster.tsx")).toContain("aria-hidden");
  });

  it("asks the optimizer for what a four by five plate needs, not for its width", () => {
    const plate = source("components/explore/Plate.tsx");
    expect(plate).toContain('sizes="(min-width: 1520px) 440px, (min-width: 1280px) 31vw, (min-width: 640px) 42vw, 50vw"');
  });
});

/** One client component, with the English words around it. */
function render(node: ReactElement): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;
  return renderToStaticMarkup(createElement(Provider, { locale: "en", messages: en, timeZone: "UTC" }, node));
}
