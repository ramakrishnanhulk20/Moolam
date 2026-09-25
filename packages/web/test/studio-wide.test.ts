import { describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";

/**
 * The wide studio, rolled into /studio on 25 September: the picture on the
 * left, the details and the button on the right, from lg only.
 *
 * What is held here is the markup and the imports. The real studio screen
 * always lays itself out wide; the same parts drawn outside it keep their one
 * column; in the wide layout the button and the band that answers it are in
 * the same column; the passport grid's short last row is closed at every column
 * count; and the stubbed fixture is a test helper no route can reach. Where
 * things land on a real screen is measured on the dev server, not here.
 */

// The done screen's actions and the failure note arrive through next/dynamic.
// Every loader is started and awaited once, so the panels render them whole.
const chunks = vi.hoisted(() => ({ pending: [] as Promise<unknown>[] }));

vi.mock("next/dynamic", async () => {
  const { createElement: make } = await import("react");
  return {
    default: (load: () => Promise<FunctionComponent<never>>, options?: { loading?: FunctionComponent }) => {
      let Loaded: FunctionComponent<never> | null = null;
      chunks.pending.push(
        load().then((component) => {
          Loaded = component;
        }),
      );
      return (props: never) =>
        Loaded === null ? (options?.loading === undefined ? null : make(options.loading)) : make(Loaded, props);
    },
  };
});

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
}));

vi.mock("next-intl/server", () => ({
  setRequestLocale: () => undefined,
  getTranslations: async () => (key: string) => key,
}));

vi.mock("@/components/providers/WalletProvider", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  WalletProvider: (props: { children?: unknown }) => createElement("div", null, props.children as never),
}));

// The passport beside the sign-in card is a registry read; none here.
vi.mock("@/components/studio/showcasePassport", () => ({ showcasePassport: async () => null }));

// What the live studio draws is not under test here, only whether the screen
// tells it to be wide. The stand-in says what it was told.
vi.mock("@/components/studio/LiveStudio", async () => {
  const { useWide } = await import("@/components/studio/layout");
  return { LiveStudio: () => createElement("p", { "data-told": useWide() ? "wide" : "one-column" }) };
});

process.env.NEXT_PUBLIC_PRIVY_APP_ID = "test-app-id";

const { RegisterPanel } = await import("@/components/studio/RegisterPanel");
const { GeneratePanel } = await import("@/components/studio/GeneratePanel");
const { YourPassports } = await import("@/components/studio/YourPassports");
const { StudioBox } = await import("@/components/studio/StudioFrame");
const { StudioScreen } = await import("@/components/studio/StudioScreen");
const { WideLayout } = await import("@/components/studio/layout");
const { WalletMounted } = await import("@/components/providers/WalletProvider");
const { PathChoice } = await import("@/components/studio/PathChoice");
const { passportEnd, passportEndClasses } = await import("@/components/studio/passportsEnd");
const { fixtureState } = await import("./studio-fixtures");
const { WideFixture, cardsOf } = await import("./wide-fixture");
const { default: StudioPage } = await import("@/app/[locale]/studio/page");

for (let seen = -1; seen !== chunks.pending.length; ) {
  seen = chunks.pending.length;
  await Promise.all(chunks.pending);
}

const NOOP = () => undefined;

function render(node: ReactElement): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
    children?: ReactNode;
  }>;
  return renderToStaticMarkup(createElement(Provider, { locale: "en", messages: en, timeZone: "UTC" }, node));
}

function wide(node: ReactElement): ReactElement {
  return createElement(WideLayout, null, node);
}

type Pose = Parameters<typeof fixtureState>[1];

function upload(pose: Pose) {
  return createElement(RegisterPanel, {
    state: fixtureState("upload", pose),
    onChoose: NOOP,
    onTitle: NOOP,
    onConsent: NOOP,
    onSealed: NOOP,
    onSaved: NOOP,
    onRegister: NOOP,
    onReset: NOOP,
    onUnsponsored: NOOP,
    onBind: NOOP,
  });
}

function generate(pose: Pose) {
  return createElement(GeneratePanel, {
    state: fixtureState("generate", pose),
    onPrompt: NOOP,
    onTitle: NOOP,
    onConsent: NOOP,
    onSealed: NOOP,
    onIncludePrompt: NOOP,
    onSaved: NOOP,
    onGenerate: NOOP,
    onReset: NOOP,
    onUnsponsored: NOOP,
    onBind: NOOP,
  });
}

function grid(count: number) {
  return {
    status: "ready" as const,
    passports: cardsOf(count),
    error: null,
    refresh: NOOP,
    hasMore: true,
    loadingMore: false,
    moreError: null,
    more: NOOP,
  };
}

/** Every class and attribute only the wide layout writes. */
const WIDE_MARKS = [
  "data-studio-layout",
  "data-studio-column",
  "data-studio-passports",
  "lg:max-w-none",
  "lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]",
  "xl:grid-cols-4",
  "data-load-more",
];

/**
 * The data-studio-column values around the first tag that carries `mark`, from
 * the outermost in. A small tag walk, because the suite runs in node with no DOM.
 */
function columnsAround(markup: string, mark: string): string[] {
  const VOID = new Set(["img", "input", "br", "hr", "meta", "link", "source", "path", "circle", "rect", "line"]);
  const stack: { name: string; column: string | null }[] = [];
  for (const tag of markup.matchAll(/<(\/?)([a-zA-Z0-9]+)([^>]*)>/g)) {
    const [whole, closing, name, rest] = tag;
    if (closing === "/") {
      const at = stack.map((entry) => entry.name).lastIndexOf(name);
      if (at >= 0) {
        stack.length = at;
      }
      continue;
    }
    if (whole.includes(mark)) {
      return stack.map((entry) => entry.column).filter((column): column is string => column !== null);
    }
    if (!VOID.has(name) && !rest.endsWith("/")) {
      stack.push({ name, column: /data-studio-column="([a-z]+)"/.exec(rest)?.[1] ?? null });
    }
  }
  throw new Error(`nothing in the markup carries ${mark}`);
}

/** The screen element a page hands over, wherever its frame puts it. */
function screenIn(node: unknown): ReactElement<Record<string, unknown>> | undefined {
  if (Array.isArray(node)) {
    return node.map(screenIn).find((found) => found !== undefined);
  }
  if (node === null || typeof node !== "object" || !("props" in node)) {
    return undefined;
  }
  const element = node as ReactElement<{ children?: unknown }>;
  return element.type === StudioScreen
    ? (element as ReactElement<Record<string, unknown>>)
    : screenIn(element.props.children);
}

describe("the real studio is wide on a laptop", () => {
  it("hands its screen no layout option: there is only the one", async () => {
    const tree = await StudioPage({ params: Promise.resolve({ locale: "en" }) });
    const screen = screenIn(tree);
    expect(screen).toBeDefined();
    expect(Object.keys(screen?.props ?? {})).toEqual(["initialMode"]);
  });

  it("tells the live studio to lay itself out wide", () => {
    const markup = render(createElement(WalletMounted.Provider, { value: true }, createElement(StudioScreen)));
    expect(markup).toContain('data-told="wide"');
  });

  it("draws every wide class under the studio's layout", () => {
    const markup = [
      render(wide(upload("idle"))),
      render(wide(createElement(StudioBox, { fill: true }, createElement("p", null, "panel")))),
      render(wide(createElement(YourPassports, { passports: grid(1) }))),
    ].join("");
    for (const mark of WIDE_MARKS) {
      expect(markup, mark).toContain(mark);
    }
  });

  it("leaves the same parts in one column outside the studio, as /mine and the lab benches draw them", () => {
    const faces = [
      upload("idle"),
      upload("preparing"),
      upload("donePublic"),
      upload("doneSealed"),
      generate("idle"),
      generate("signing"),
      generate("donePublic"),
      createElement(StudioBox, { fill: true }, createElement("p", null, "panel")),
      createElement(YourPassports, { passports: grid(1) }),
    ];
    for (const face of faces) {
      const markup = render(face);
      for (const mark of WIDE_MARKS) {
        expect(markup, mark).not.toContain(mark);
      }
      expect(markup).not.toContain("data-passports-end");
    }
  });

  it("keeps the sign in and the other single cards at their own width even under the wide layout", () => {
    const markup = render(wide(createElement(StudioBox, {}, createElement("p", null, "card"))));
    expect(markup).not.toContain("lg:max-w-none");
  });
});

describe("the path switch under the wide layout", () => {
  it("is the full fork at every width until it has found the opening's slot, so a page without one still has it", () => {
    const markup = render(wide(createElement(PathChoice, { mode: "upload", busy: false, onMode: NOOP })));
    expect(markup).not.toContain("data-path-compact");
    expect(markup).not.toContain(`<div class="lg:hidden">`);
    expect(markup.split(en.studio.choice.upload.label).length - 1).toBe(1);
  });

  it("steps the phone's fork aside once the run has started, as the one column always did", () => {
    const markup = render(wide(createElement(PathChoice, { mode: "upload", busy: true, running: true, onMode: NOOP })));
    expect(markup).toBe("");
  });

  it("is the one fork outside the studio", () => {
    const markup = render(createElement(PathChoice, { mode: "upload", busy: false, onMode: NOOP }));
    expect(markup).not.toContain("data-path-compact");
    expect(markup.split(en.studio.choice.upload.label).length - 1).toBe(1);
  });
});

describe("where a press is answered in the wide layout", () => {
  it("puts the upload button and the band that replaces it in the same column", () => {
    expect(columnsAround(render(wide(upload("idle"))), "data-press")).toEqual(["details"]);
    expect(columnsAround(render(wide(upload("preparing"))), "data-studio-band")).toEqual(["details"]);
    expect(columnsAround(render(wide(upload("donePublic"))), "data-studio-band")).toEqual(["details"]);
  });

  it("does the same on the generate path", () => {
    expect(columnsAround(render(wide(generate("idle"))), "data-press")).toEqual(["details"]);
    expect(columnsAround(render(wide(generate("signing"))), "data-studio-band")).toEqual(["details"]);
    expect(columnsAround(render(wide(generate("donePublic"))), "data-studio-band")).toEqual(["details"]);
  });

  it("puts the title and the sealed choice with the picture, and the AI-use choice with the button", () => {
    for (const markup of [render(wide(upload("idle"))), render(wide(generate("idle")))]) {
      expect(columnsAround(markup, `maxLength="120"`)).toEqual(["picture"]);
      expect(columnsAround(markup, `class="hidden lg:`)).toEqual(["picture"]);
      expect(columnsAround(markup, "data-choice=")).toEqual(["details"]);
    }
  });

  it("does not move the page on a press when the wide box starts in the upper half, and keeps today's rule otherwise", async () => {
    const { scrollTarget } = await import("@/components/studio/press");
    const { WIDE_REACH } = await import("@/components/studio/layout");
    // The real /studio at 1440x900, signed in, puts the box top at 301 px under a 63 px bar
    // (kitchen/reports/WO-163-look/look.txt).
    expect(scrollTarget(301, 63, 900, WIDE_REACH)).toBeNull();
    expect(scrollTarget(301, 63, 900)).toBe(301 - 63 - 16);
    expect(scrollTarget(600, 63, 900, WIDE_REACH)).toBe(600 - 63 - 16);
  });

  it("keeps the run's step rows beside the band, not under the picture", () => {
    expect(columnsAround(render(wide(upload("preparing"))), 'data-step="prepare"')).toEqual(["details"]);
    expect(columnsAround(render(wide(generate("signing"))), 'data-step="draw"')).toEqual(["details"]);
  });
});

describe("the passport grid's short last row", () => {
  // The cells the last row leaves empty at two, three and four columns.
  const EXPECTED: Record<number, { sm: number; lg: number; xl: number }> = {
    1: { sm: 1, lg: 2, xl: 3 },
    2: { sm: 0, lg: 1, xl: 2 },
    3: { sm: 1, lg: 0, xl: 1 },
    4: { sm: 0, lg: 2, xl: 0 },
    5: { sm: 1, lg: 1, xl: 3 },
  };

  it.each([1, 2, 3, 4, 5])("is closed exactly with %i cards at two, three and four columns", (count) => {
    const end = passportEnd(count);
    expect(end).toEqual(EXPECTED[count]);
    expect((count + end.sm) % 2).toBe(0);
    expect((count + end.lg) % 3).toBe(0);
    expect((count + end.xl) % 4).toBe(0);

    const markup = render(wide(createElement(YourPassports, { passports: grid(count) })));
    expect(markup.match(/<li/g)?.length).toBe(count + 1);
    const cell = /<li[^>]*data-passports-end[^>]*>/.exec(markup)?.[0] ?? "";
    expect(cell).toContain(passportEndClasses(end));
    expect(cell).toContain('aria-hidden="true"');
    // The grid's own column classes are the ones the count is worked out for.
    expect(markup).toContain("sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4");
  });

  it("is not drawn where every row is full", () => {
    expect(passportEnd(12)).toEqual({ sm: 0, lg: 0, xl: 0 });
    expect(render(wide(createElement(YourPassports, { passports: grid(12) })))).not.toContain("data-passports-end");
  });

  it("fills every short row exactly, for any count a Load more can reach", () => {
    for (let count = 1; count <= 120; count += 1) {
      const end = passportEnd(count);
      expect((count + end.sm) % 2).toBe(0);
      expect((count + end.lg) % 3).toBe(0);
      expect((count + end.xl) % 4).toBe(0);
    }
  });
});

describe("the stubbed fixture", () => {
  it("draws the wide layout, with no lab flag needed, for tests and measuring", () => {
    const markup = render(createElement(WideFixture, { name: "upload" }));
    expect(markup).toContain('data-studio-layout="wide"');
    expect(markup).toContain('data-wide-fixture="upload"');
  });

  it("is reached by no route: no page, layout or handler imports it, however far its imports are followed", () => {
    const routes = filesUnder(join(web, "app")).filter((file) =>
      /[\\/](page|layout|route|not-found|error|global-error|template|default)\.tsx?$/.test(file),
    );
    expect(routes.length).toBeGreaterThan(10);
    for (const route of routes) {
      const reached = [...reachedFrom(route)];
      expect(
        reached.filter((file) => file.startsWith("test/") || /wide-?fixture/i.test(file)),
        route,
      ).toEqual([]);
    }
  });

  it("is named by no source file outside test/", () => {
    for (const root of ["app", "components", "lib"]) {
      for (const file of filesUnder(join(web, root)).filter((name) => /\.(ts|tsx|mjs|js)$/.test(name))) {
        expect(readFileSync(file, "utf8"), file).not.toMatch(/wide-fixture|WideFixture/);
      }
    }
  });

  it("is gone from the studio's own components, and so are the lab page and the opening option", () => {
    expect(existsSync(join(web, "components/studio/WideFixture.tsx"))).toBe(false);
    expect(existsSync(join(web, "components/studio/opening.tsx"))).toBe(false);
    expect(existsSync(join(web, "app/[locale]/lab/studio-wide"))).toBe(false);
  });
});

describe("what the wide layout adds to what a page loads", () => {
  const WALLET = ["@privy-io/react-auth", "@privy-io/wagmi", "wagmi", "@tanstack/react-query"];

  it("adds only the small layout file to the studio's first load, and no wallet package", () => {
    const first = shipped("@/app/[locale]/studio/page.tsx");
    expect(first.files).toContain("components/studio/layout.tsx");
    for (const file of ["components/studio/LiveStudio.tsx", "components/studio/RegisterPanel.tsx", "components/studio/PathChoice.tsx"]) {
      expect(first.files, file).not.toContain(file);
    }
    expect([...first.packages].filter((name) => WALLET.includes(name))).toEqual([]);
  });
});

const web = fileURLToPath(new URL("..", import.meta.url));
const STATIC = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/g;
const DYNAMIC = /import\s*\(\s*["']([^"']+)["']/g;

function fileFor(specifier: string, from: string): string | null {
  if (!specifier.startsWith("@/") && !specifier.startsWith(".")) {
    return null;
  }
  const base = specifier.startsWith("@/") ? join(web, specifier.slice(2)) : resolve(dirname(from), specifier);
  const tries = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")];
  return tries.find((path) => existsSync(path) && /\.tsx?$/.test(path)) ?? null;
}

function filesUnder(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

/** Every app file a route reaches, server side and browser side, static and dynamic imports alike. */
function reachedFrom(entry: string): Set<string> {
  const files = new Set<string>();
  const walk = (file: string) => {
    const name = file.slice(web.length).replace(/\\/g, "/");
    if (files.has(name)) {
      return;
    }
    files.add(name);
    const source = readFileSync(file, "utf8");
    const specifiers = [
      ...[...source.matchAll(STATIC)].map((match) => match[2]),
      ...[...source.matchAll(DYNAMIC)].map((match) => match[1]),
    ];
    for (const specifier of specifiers) {
      const next = fileFor(specifier, file);
      if (next !== null) {
        walk(next);
      }
    }
  };
  walk(entry);
  return files;
}

/**
 * What a route ships to the browser, walked the way test/studio-weight.test.ts
 * walks it: browser side from the first "use client" file down, stopping at
 * every import( unless `later` is on.
 */
function shipped(entry: string, later = false): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const seen = new Set<string>();

  const walk = (file: string, client: boolean) => {
    const key = `${file}::${String(client)}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);

    const source = readFileSync(file, "utf8");
    const browser = client || /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use client["']/.test(source);
    if (browser) {
      files.add(file.slice(web.length).replace(/\\/g, "/"));
    }

    const specifiers = [...source.matchAll(STATIC)].filter((match) => match[1] === undefined).map((match) => match[2]);
    if (later) {
      specifiers.push(...[...source.matchAll(DYNAMIC)].map((match) => match[1]));
    }

    for (const specifier of specifiers) {
      const next = fileFor(specifier, file);
      if (next === null) {
        if (browser && !specifier.startsWith("node:") && !specifier.startsWith("@/") && !specifier.startsWith(".")) {
          packages.add(specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]);
        }
        continue;
      }
      walk(next, browser);
    }
  };

  walk(fileFor(entry, join(web, "x.ts")) as string, false);
  return { files, packages };
}
