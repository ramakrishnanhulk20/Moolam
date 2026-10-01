import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement, type FunctionComponent, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
 * What the home page sends before any script has run, and what it leaves for
 * later.
 *
 * The page is rendered to a string the way the server sends it, with the reads
 * answered here in the network's stead. Screen one has to be in that string as
 * words, with nothing hiding it behind an opacity a script would have to lift.
 * The film has to be absent from it: only its box, with no picture asked for,
 * and no path from the page to three.js that does not go through a dynamic
 * import.
 */

const stub = vi.hoisted(() => ({ story: vi.fn(), first: vi.fn(), hold: vi.fn() }));

vi.mock("@/components/story/data", () => ({ heldStory: stub.story }));
vi.mock("@/components/home/read", () => ({ firstScreenData: stub.first, holdFirstScreen: stub.hold }));
vi.mock("next-intl/server", () => ({ setRequestLocale: () => undefined, getTranslations: async () => () => "" }));
vi.mock("@/components/guide/FirstVisitGuide", () => ({ FirstVisitGuide: () => null }));
vi.mock("@/lib/i18n/routing", () => ({
  routing: { locales: ["en", "ta", "hi", "zh", "ja", "ko", "es", "fr", "de", "pt"], defaultLocale: "en" },
  Link: (props: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
}));
vi.mock("@/components/passport/Picture", () => ({
  Picture: (props: { alt?: string }) => createElement("span", { "data-picture": props.alt ?? "" }),
}));
vi.mock("@/components/verify/AnswerCard", () => ({ AnswerCard: () => null }));

const { default: HomePage, generateStaticParams } = await import("@/app/[locale]/page");
const { FINDING_ID } = await import("@/components/home/finding");

const PHASH = 7840506850305415717n;

const FIRST = {
  finding: {
    read: {
      id: FINDING_ID,
      title: "Monsoon Fishing Nets Drying",
      picture: "https://gateway.example/ipfs/full",
      thumbnail: "https://gateway.example/ipfs/thumb",
      registeredAt: 1_788_881_666,
      phash: PHASH.toString(),
      recheck: { matched: true, distance: 0, at: 1_789_380_000 },
      statement: { summary: "closed" as const, at: 1_789_700_000 },
      statementError: null,
    },
  },
  copy: { failed: "the copy is only made while the site is built" },
  samples: [{ id: `0x${"2b".repeat(32)}` as Hex, url: "https://gateway.example/ipfs/ant", title: "Ant and Elephants" }],
  loose: null,
};

const PLATE = "https://gateway.example/ipfs/plate";

beforeEach(() => {
  stub.first.mockReset().mockResolvedValue(FIRST);
  stub.story.mockReset().mockResolvedValue({
    source: "envio",
    plates: [{ id: `0x${"3c".repeat(32)}`, picture: PLATE, agentId: null, registeredAt: 1_788_000_000 }],
    focal: null,
    attestation: null,
    agent: null,
    statement: null,
    statementError: null,
    passportCount: 1,
    attestationCount: 0,
    error: null,
  });
});

const MESSAGES = { en, ta, hi, ja, ko, zh, de, es, fr, pt } as const;
type Locale = keyof typeof MESSAGES;

async function served(locale: Locale): Promise<string> {
  const page = await HomePage({ params: Promise.resolve({ locale }) });
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
    children: ReactNode;
  }>;
  return renderToString(createElement(Provider, { locale, messages: MESSAGES[locale], timeZone: "UTC" }, page));
}

/** The text of the markup with the tags taken out, so a sentence split across elements still reads whole. */
function text(html: string): string {
  return html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .replace(/ ([.,:])/g, "$1");
}

describe("screen one, as the server sends it", () => {
  for (const locale of ["en", "ta"] as const) {
    it(`carries the headline, the line, the action and the sponsor line as words in ${locale}`, async () => {
      const first = MESSAGES[locale].home.first;
      const words = text(await served(locale));

      expect(words).toContain(`${first.headline} ${first.headlineTail}`);
      expect(words).toContain(first.line);
      expect(words).toContain(first.drop);
      expect(words).toContain("Ant and Elephants");
      expect(words).toContain(first.make);
      for (const credit of Object.values(first.billing)) {
        expect(words).toContain(credit);
      }
    });
  }

  it("quotes the live finding in the reader's language, with every figure read", async () => {
    expect(text(await served("en"))).toContain(
      "A Chainlink workflow checked the registered picture itself on Sep 14, 2026: 0 of 64 bits apart from its record.",
    );
    const tamil = text(await served("ta"));
    expect(tamil).toContain(ta.passport.consent.summary.closed);
    expect(tamil).toContain("அதன் பதிவிலிருந்து 64-இல் 0 பிட்கள் வேறுபாடு");
  });

  it("hides none of it behind an opacity only a script would lift", async () => {
    // The stylesheet the fingerprint moment carries has its own opacity rules
    // for the cells, so it is taken out before the markup is read.
    for (const locale of ["en", "ta"] as const) {
      const html = (await served(locale)).replace(/<style[\s\S]*?<\/style>/g, "");
      const headline = html.slice(0, html.indexOf("</h1>"));

      expect(headline).toContain("data-first-line");
      expect(headline).not.toMatch(/opacity:\s*0/);
      expect(html).not.toMatch(/style="[^"]*opacity:\s*0[;"]/);
    }
  });

  it("is the page's first heading", async () => {
    const html = await served("en");
    expect(html.indexOf("<h1")).toBe(html.indexOf("<h1 data-first-line"));
  });
});

describe("when the page is drawn", () => {
  it("is drawn when the site is built, in all ten languages, once the first screen's reads are held", async () => {
    stub.hold.mockReset().mockResolvedValue(true);

    const params = await generateStaticParams();

    expect(stub.hold).toHaveBeenCalledTimes(1);
    expect(params.map((param) => param.locale).sort()).toEqual(Object.keys(MESSAGES).sort());
  });

  it("is still drawn when the copy could not be made", async () => {
    stub.hold.mockReset().mockResolvedValue(false);
    expect(await generateStaticParams()).toHaveLength(10);
  });
});

describe("the film under it", () => {
  it("is only its box in the server's markup: no scene, and none of its pictures asked for", async () => {
    const html = await served("en");

    expect(html).toContain("data-film-gate");
    expect(html).toContain('data-film="loading"');
    expect(html).not.toMatch(/<div[^>]*data-film="film"/);
    expect(html).not.toContain(PLATE);
    expect(html).not.toMatch(/<link[^>]+rel="preload"[^>]+as="image"/);
  });
});

const web = fileURLToPath(new URL("..", import.meta.url));

const ANY_IMPORT = /(?:from\s*|import\s*\(\s*)["']([^"']+)["']/g;
const STATIC_ONLY = /from\s*["']([^"']+)["']/g;

/** The packages the film is made of. None of them may reach the page without a dynamic import in the way. */
const FILM = ["three", "@react-three/fiber", "@react-three/drei"];

function fileFor(specifier: string, from: string): string | null {
  if (!specifier.startsWith("@/") && !specifier.startsWith(".")) {
    return null;
  }
  const base = specifier.startsWith("@/") ? join(web, specifier.slice(2)) : resolve(dirname(from), specifier);
  const tries = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")];
  return tries.find((path) => existsSync(path) && /\.tsx?$/.test(path)) ?? null;
}

/** Every file and package a route reaches, walking only the imports the pattern matches. */
function reach(entry: string, imports: RegExp): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const walk = (file: string) => {
    if (files.has(file)) {
      return;
    }
    files.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(imports)) {
      const specifier = match[1];
      const next = fileFor(specifier, file);
      if (next === null) {
        if (!specifier.startsWith(".") && !specifier.startsWith("node:")) {
          packages.add(specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]);
        }
        continue;
      }
      walk(next);
    }
  };
  walk(fileFor(entry, join(web, "x.ts")) as string);
  return { files, packages };
}

describe("what the home page loads before screen one has painted", () => {
  const HOME = "@/app/[locale]/page.tsx";

  it("reaches no part of the film without following a dynamic import", () => {
    const { files, packages } = reach(HOME, STATIC_ONLY);

    expect([...packages].filter((name) => FILM.includes(name))).toEqual([]);
    expect([...files].some((file) => file.endsWith(join("story", "LandingStory.tsx")))).toBe(false);
  });

  it("does reach the film one dynamic import away, so the walk itself is not the pass", () => {
    const { files, packages } = reach(HOME, ANY_IMPORT);

    expect(packages).toContain("three");
    expect(packages).toContain("@react-three/fiber");
    expect([...files].some((file) => file.endsWith(join("story", "LandingStory.tsx")))).toBe(true);
  });
});

/** Every key under a message object, as dotted paths. */
function paths(value: unknown, at = ""): string[] {
  if (value === null || typeof value !== "object") {
    return [at];
  }
  return Object.entries(value).flatMap(([key, inner]) => paths(inner, at === "" ? key : `${at}.${key}`));
}

describe("screen one in ten languages", () => {
  const english = paths(en.home.first).sort();

  it.each(Object.keys(MESSAGES) as Locale[])("%s carries every one of screen one's keys, and nothing else", (locale) => {
    const messages = MESSAGES[locale];
    expect(paths(messages.home.first).sort()).toEqual(english);
    for (const key of english) {
      const value = key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], messages.home.first);
      expect(typeof value === "string" && value.trim().length > 0, `${locale} home.first.${key}`).toBe(true);
    }
  });

  it.each(Object.keys(MESSAGES) as Locale[])("%s describes the home page to a search result with the why line itself", (locale) => {
    expect(MESSAGES[locale].meta.home).toBe(MESSAGES[locale].home.first.line);
  });

  it.each(Object.keys(MESSAGES) as Locale[])("%s keeps the four sponsors' names as they are", (locale) => {
    const billing = MESSAGES[locale].home.first.billing;
    expect(billing.monad).toContain("Monad");
    expect(billing.privy).toContain("Privy");
    expect(billing.chainlink).toContain("Chainlink");
    expect(billing.envio).toContain("Envio");
  });

  it("writes no long dash in any of them", () => {
    const LONG_DASH = String.fromCharCode(0x2014);
    for (const messages of Object.values(MESSAGES)) {
      expect(JSON.stringify(messages.home.first)).not.toContain(LONG_DASH);
    }
  });
});
