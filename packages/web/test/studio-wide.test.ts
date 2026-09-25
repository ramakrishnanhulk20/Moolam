import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";

/**
 * The wide studio on /lab/studio-wide: the picture on the left, the details and
 * the button on the right, from lg only.
 *
 * What is held here is the markup and the imports. The real studio route hands
 * its screen no layout and draws none of the wide classes; the lab route is a
 * 404 without the lab flag; the stubbed fixture mode is reachable from the lab
 * page alone; and in the wide layout the button and the band that answers it
 * are in the same column. Where things land on a real screen is measured on the
 * dev server, not here.
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

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

vi.mock("next-intl/server", () => ({
  setRequestLocale: () => undefined,
  getTranslations: async () => (key: string) => key,
}));

vi.mock("@/components/providers/WalletProvider", () => ({
  WalletProvider: (props: { children?: unknown }) => createElement("div", null, props.children as never),
}));

const { RegisterPanel } = await import("@/components/studio/RegisterPanel");
const { GeneratePanel } = await import("@/components/studio/GeneratePanel");
const { YourPassports } = await import("@/components/studio/YourPassports");
const { StudioBox } = await import("@/components/studio/StudioFrame");
const { StudioScreen } = await import("@/components/studio/StudioScreen");
const { StudioLayoutProvider } = await import("@/components/studio/layout");
const { WideFixture } = await import("@/components/studio/WideFixture");
const { PathChoice } = await import("@/components/studio/PathChoice");
const { fixtureState } = await import("@/components/lab/studio/fixtures");
const { default: StudioPage } = await import("@/app/[locale]/studio/page");
const { default: WideLabPage } = await import("@/app/[locale]/lab/studio-wide/page");

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
  return createElement(StudioLayoutProvider, { layout: "wide" }, node);
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

const PASSPORTS = {
  status: "ready" as const,
  passports: [
    {
      id: `0x${"ab".repeat(32)}` as const,
      kind: 1,
      registeredAt: 1_790_000_000n,
      registeredBlock: 1n,
      metadataURI: "ipfs://meta",
      title: "Harbour",
    },
  ],
  error: null,
  refresh: NOOP,
  hasMore: true,
  loadingMore: false,
  moreError: null,
  more: NOOP,
};

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
function screenIn(node: unknown): ReactElement<{ layout?: string }> | undefined {
  if (Array.isArray(node)) {
    return node.map(screenIn).find((found) => found !== undefined);
  }
  if (node === null || typeof node !== "object" || !("props" in node)) {
    return undefined;
  }
  const element = node as ReactElement<{ children?: unknown; layout?: string }>;
  return element.type === StudioScreen ? element : screenIn(element.props.children);
}

function holds(node: unknown, type: unknown): boolean {
  if (Array.isArray(node)) {
    return node.some((child) => holds(child, type));
  }
  if (node === null || typeof node !== "object" || !("props" in node)) {
    return false;
  }
  const element = node as ReactElement<{ children?: unknown }>;
  return element.type === type || holds(element.props.children, type);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the real studio keeps today's layout", () => {
  it("hands its screen no layout, so the screen draws the stacked one", async () => {
    const tree = await StudioPage({ params: Promise.resolve({ locale: "en" }) });
    const screen = screenIn(tree);
    expect(screen).toBeDefined();
    expect(screen?.props.layout).toBeUndefined();
  });

  it("draws none of the wide classes on any face of either panel, the box or the grid", () => {
    const faces = [
      upload("idle"),
      upload("preparing"),
      upload("donePublic"),
      upload("doneSealed"),
      generate("idle"),
      generate("signing"),
      generate("donePublic"),
      createElement(StudioBox, { fill: true }, createElement("p", null, "panel")),
      createElement(YourPassports, { passports: PASSPORTS }),
    ];
    for (const face of faces) {
      const markup = render(face);
      for (const mark of WIDE_MARKS) {
        expect(markup, mark).not.toContain(mark);
      }
    }
  });

  it("draws them all under the wide layout, so the check above is not passing on nothing", () => {
    const markup = [
      render(wide(upload("idle"))),
      render(wide(createElement(StudioBox, { fill: true }, createElement("p", null, "panel")))),
      render(wide(createElement(YourPassports, { passports: PASSPORTS }))),
    ].join("");
    for (const mark of WIDE_MARKS) {
      expect(markup, mark).toContain(mark);
    }
  });

  it("keeps the sign in and the other single cards at today's width even under the wide layout", () => {
    const markup = render(wide(createElement(StudioBox, {}, createElement("p", null, "card"))));
    expect(markup).not.toContain("lg:max-w-none");
  });
});

describe("the path switch under the wide layout", () => {
  it("is in the first render in both sizes, the width picking one, so nothing moves in after load", () => {
    const markup = render(wide(createElement(PathChoice, { mode: "upload", busy: false, onMode: NOOP })));
    expect(markup).toContain("data-path-compact");
    expect(markup).toContain(`<div class="lg:hidden">`);
    expect(markup.split(en.studio.choice.upload.label).length - 1).toBe(2);
  });

  it("is today's one fork under the stacked layout", () => {
    const markup = render(createElement(PathChoice, { mode: "upload", busy: false, onMode: NOOP }));
    expect(markup).not.toContain("data-path-compact");
    expect(markup.split(en.studio.choice.upload.label).length - 1).toBe(1);
  });
});

describe("the lab route", () => {
  it("is a 404 without the lab flag, before anything is drawn", async () => {
    vi.stubEnv("NEXT_PUBLIC_LAB_PAGES", "");
    await expect(
      WideLabPage({ params: Promise.resolve({ locale: "en" }), searchParams: Promise.resolve({ fixture: "upload" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("draws the real studio screen, told to be wide, when no fixture is asked for", async () => {
    vi.stubEnv("NEXT_PUBLIC_LAB_PAGES", "1");
    const tree = await WideLabPage({ params: Promise.resolve({ locale: "en" }), searchParams: Promise.resolve({}) });
    expect(screenIn(tree)?.props.layout).toBe("wide");
    expect(holds(tree, WideFixture)).toBe(false);
  });

  it("draws the fixture instead of the wallet screen when one is asked for", async () => {
    vi.stubEnv("NEXT_PUBLIC_LAB_PAGES", "1");
    const tree = await WideLabPage({
      params: Promise.resolve({ locale: "en" }),
      searchParams: Promise.resolve({ fixture: "done" }),
    });
    expect(holds(tree, WideFixture)).toBe(true);
    expect(screenIn(tree)).toBeUndefined();
  });
});

describe("the fixture mode", () => {
  it("cannot be reached from /studio: the page ignores the parameter and never imports the fixture", async () => {
    const tree = await StudioPage({
      params: Promise.resolve({ locale: "en" }),
      searchParams: Promise.resolve({ fixture: "upload" }),
    });
    expect(holds(tree, WideFixture)).toBe(false);
    expect(screenIn(tree)?.props.layout).toBeUndefined();

    const everything = shipped("@/app/[locale]/studio/page.tsx", true).files;
    expect(everything).not.toContain("components/studio/WideFixture.tsx");
    expect([...everything].filter((file) => file.startsWith("components/lab/"))).toEqual([]);
    expect(readFileSync(join(web, "app/[locale]/studio/page.tsx"), "utf8")).not.toMatch(/fixture/i);
  });

  it("draws nothing at all without the lab flag", () => {
    vi.stubEnv("NEXT_PUBLIC_LAB_PAGES", "");
    expect(render(createElement(WideFixture, { name: "upload" }))).toBe("");
  });

  it("draws the wide layout with the lab flag", () => {
    vi.stubEnv("NEXT_PUBLIC_LAB_PAGES", "1");
    const markup = render(createElement(WideFixture, { name: "upload" }));
    expect(markup).toContain('data-studio-layout="wide"');
    expect(markup).toContain('data-wide-fixture="upload"');
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
    // The wide lab page at 1440x900 puts the box top at 317 px under a 63 px bar.
    expect(scrollTarget(317, 63, 900, WIDE_REACH)).toBeNull();
    expect(scrollTarget(317, 63, 900)).toBe(317 - 63 - 16);
    expect(scrollTarget(600, 63, 900, WIDE_REACH)).toBe(600 - 63 - 16);
  });

  it("keeps the run's step rows beside the band, not under the picture", () => {
    expect(columnsAround(render(wide(upload("preparing"))), 'data-step="prepare"')).toEqual(["details"]);
    expect(columnsAround(render(wide(generate("signing"))), 'data-step="draw"')).toEqual(["details"]);
  });
});

describe("what the wide layout adds to what a page loads", () => {
  const WALLET = ["@privy-io/react-auth", "@privy-io/wagmi", "wagmi", "@tanstack/react-query"];

  it("adds only the small layout file to the studio's first load, and no wallet package", () => {
    const first = shipped("@/app/[locale]/studio/page.tsx");
    expect(first.files).toContain("components/studio/layout.tsx");
    for (const file of ["components/studio/LiveStudio.tsx", "components/studio/RegisterPanel.tsx", "components/studio/WideFixture.tsx"]) {
      expect(first.files, file).not.toContain(file);
    }
    expect([...first.packages].filter((name) => WALLET.includes(name))).toEqual([]);
  });

  it("keeps the wallet out of the lab page's first load too, fixture and all", () => {
    const first = shipped("@/app/[locale]/lab/studio-wide/page.tsx");
    expect([...first.packages].filter((name) => WALLET.includes(name))).toEqual([]);
    expect(first.files).toContain("components/studio/WideFixture.tsx");
    expect(shipped("@/app/[locale]/lab/studio-wide/page.tsx", true).packages).toContain("@privy-io/react-auth");
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
