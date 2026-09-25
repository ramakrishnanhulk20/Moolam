import { describe, expect, it, vi } from "vitest";
import { createElement, isValidElement, type FunctionComponent, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NextIntlClientProvider, createTranslator } from "next-intl";
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
 * The studio and /mine were 2.2 MB of script on a phone, and the words
 * a visitor reads first on each page waited 11.5 s and 16.1 s for it, because
 * they were drawn by motion components that the HTML served at opacity 0.
 *
 * Two things are held here. The first words on both pages are in the server's
 * HTML, visible, in all ten languages, without a line of script having run. And
 * the code that only a signed in creator, a press or a sealed run ever uses is
 * not in the import graph a page loads before it paints.
 */

const MESSAGES = { en, ta, hi, zh, ja, ko, es, fr, de, pt } as const;
type Locale = keyof typeof MESSAGES;
const LOCALES = Object.keys(MESSAGES) as Locale[];

// The screens only paint their waiting card under a configured app id.
process.env.NEXT_PUBLIC_PRIVY_APP_ID = "test-app-id";

const request = vi.hoisted(() => ({ locale: "en" }));

vi.mock("next-intl/server", async () => {
  const { createTranslator: translator } = await import("next-intl");
  const all = {
    de: (await import("@/messages/de.json")).default,
    en: (await import("@/messages/en.json")).default,
    es: (await import("@/messages/es.json")).default,
    fr: (await import("@/messages/fr.json")).default,
    hi: (await import("@/messages/hi.json")).default,
    ja: (await import("@/messages/ja.json")).default,
    ko: (await import("@/messages/ko.json")).default,
    pt: (await import("@/messages/pt.json")).default,
    ta: (await import("@/messages/ta.json")).default,
    zh: (await import("@/messages/zh.json")).default,
  } as Record<string, Record<string, unknown>>;
  return {
    setRequestLocale: (locale: string) => {
      request.locale = locale;
    },
    getTranslations: async (options: string | { locale: string; namespace: string }) => {
      const { locale, namespace } =
        typeof options === "string" ? { locale: request.locale, namespace: options } : options;
      return translator({ locale, messages: all[locale], namespace: namespace as never });
    },
  };
});

// A server render never runs an effect, so the wallet is never fetched and the
// live halves of both screens are never asked for. The stand-in draws what the
// real one would while a chunk is on its way, and never calls the loader, so
// nothing in the markup below can have come from the code that was moved.
vi.mock("next/dynamic", async () => {
  const { createElement: make } = await import("react");
  return {
    default: (_load: unknown, options?: { loading?: FunctionComponent }) => () =>
      options?.loading === undefined ? null : make(options.loading),
  };
});

// /mine sets one real passport beside its sign-in card, read from the chain.
// That read and its drawing come after the words held here, so they are stood
// down: no network in a unit test, and the import graph below is read from the
// files themselves, not from these stand-ins.
vi.mock("@/components/studio/showcasePassport", () => ({ showcasePassport: async () => null }));
vi.mock("@/components/studio/Showcase", () => ({ Showcase: () => null }));

const { default: StudioPage } = await import("@/app/[locale]/studio/page");
const { default: MinePage } = await import("@/app/[locale]/mine/page");

/**
 * The route's server component rendered to a string, the way the server sends
 * it. The page itself and the intro inside it are async server components, which
 * the string renderer cannot wait on, so they are awaited here first and the
 * client components under them are rendered as the server would.
 */
async function serve(page: ReactNode, locale: Locale): Promise<string> {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
    children?: ReactNode;
  }>;
  const tree = await settle(await page);
  return renderToStaticMarkup(
    createElement(Provider, { locale, messages: MESSAGES[locale], timeZone: "Asia/Kolkata" }, tree),
  );
}

async function settle(node: unknown): Promise<ReactNode> {
  if (Array.isArray(node)) {
    return Promise.all(node.map(settle));
  }
  if (!isValidElement(node)) {
    return node as ReactNode;
  }
  const element = node as { type: unknown; props: Record<string, unknown> };
  if (typeof element.type === "function" && element.type.constructor.name === "AsyncFunction") {
    return settle(await (element.type as (props: unknown) => Promise<unknown>)(element.props));
  }
  if (element.props.children === undefined) {
    return node;
  }
  const children = await settle(element.props.children);
  return createElement(element.type as string, { ...element.props, key: (node as { key?: string }).key }, children);
}

/** The markup from the first word up to the last, which must carry no hidden style. */
function between(markup: string, first: string, last: string): string {
  const start = markup.indexOf(first);
  const end = markup.indexOf(last, start);
  expect(start, `"${first.slice(0, 40)}" should be in the served HTML`).toBeGreaterThan(-1);
  expect(end, `"${last.slice(0, 40)}" should follow it`).toBeGreaterThan(-1);
  return markup.slice(start, end + last.length);
}

/** What the HTML would have to say for the words to wait on script: a motion component's opening pose. */
const HIDDEN = /opacity:\s*0(?![.\d])/;

/** The same text as it appears in HTML, with the five characters React escapes. */
function html(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}

describe("the studio's first words are in the server's HTML", () => {
  it.each(LOCALES)("%s: the kicker, the title, the lede and the sign in card, none of them hidden", async (locale) => {
    const t = createTranslator({ locale, messages: MESSAGES[locale], namespace: "studio" });
    const markup = await serve(StudioPage({ params: Promise.resolve({ locale }) }), locale);

    const lead = between(markup, html(t("kicker")), html(t("signedOut.heading")));
    expect(lead).toContain(html(t("title")));
    expect(lead).toContain(html(t("lede")));
    expect(lead).not.toMatch(HIDDEN);
    expect(markup).toContain('data-opening="compact"');
    // The waiting card is the one a visitor reads next, and the stub under it.
    expect(markup).toContain(html(t("signedOut.button")));
    expect(markup).toContain(html(t("receipt.heading")));
  });

  it("gives Tamil the looser leading on the title, and Latin the tight one", async () => {
    const tamil = await serve(StudioPage({ params: Promise.resolve({ locale: "ta" }) }), "ta");
    const latin = await serve(StudioPage({ params: Promise.resolve({ locale: "en" }) }), "en");
    expect(tamil).toMatch(/<h1[^>]*leading-\[1\.2\]/);
    expect(latin).toMatch(/<h1[^>]*leading-\[0\.92\]/);
  });
});

describe("/mine's first words are in the server's HTML", () => {
  it.each(LOCALES)("%s: the heading, the lede and the sign in card's heading, none of them hidden", async (locale) => {
    const t = createTranslator({ locale, messages: MESSAGES[locale], namespace: "mine" });
    const markup = await serve(MinePage({ params: Promise.resolve({ locale }) }), locale);

    const lead = between(markup, html(t("kicker")), html(t("signedOut.heading")));
    expect(lead).toContain(html(t("heading")));
    expect(lead).toContain(html(t("lede")));
    expect(lead).not.toMatch(HIDDEN);
    expect(markup).toContain(html(t("signedOut.button")));
  });
});

const web = fileURLToPath(new URL("..", import.meta.url));

/**
 * Every edge that is really an import of code. `import type` is left out, since
 * the compiler erases it and it costs a page nothing.
 */
const STATIC = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/g;

/** The same, plus every `import(` expression: what a page may fetch later on its own. */
const DYNAMIC = /import\s*\(\s*["']([^"']+)["']/g;

/** The file a specifier points at, or null when it leaves this app. */
function fileFor(specifier: string, from: string): string | null {
  if (!specifier.startsWith("@/") && !specifier.startsWith(".")) {
    return null;
  }
  const base = specifier.startsWith("@/") ? join(web, specifier.slice(2)) : resolve(dirname(from), specifier);
  const tries = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")];
  return tries.find((path) => existsSync(path) && /\.tsx?$/.test(path)) ?? null;
}

/**
 * What a route ships to the browser, as app files and packages.
 *
 * Followed the way tests/wallet-routes.test.ts follows it: the walk turns
 * browser side at the first "use client" file, since everything from there down
 * is shipped. With `later` off it stops at every `import(`, which is what the
 * page loads before it can paint; with it on, it follows them too.
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

const STUDIO = "@/app/[locale]/studio/page.tsx";
const MINE = "@/app/[locale]/mine/page.tsx";

/** Each module moved out of the first load, and when it now arrives. */
const MOVED = {
  // With the wallet SDK, once the page has painted.
  "components/studio/LiveStudio.tsx": "the studio's hook, sign in and every card, fetched beside the SDK",
  "lib/studio/useStudio.ts": "the studio's hook: Privy's hooks, the passkey, the prepare and send code",
  "components/mine/MinePictures.tsx": "/mine's Privy hooks, fetched beside the SDK",
  // Only once someone has signed in.
  "components/studio/IdentityStrip.tsx": "the signed in strip",
  "components/studio/BindCard.tsx": "the passkey bind card",
  "components/studio/RecoverCard.tsx": "the second device card",
  "components/studio/PathChoice.tsx": "the upload or generate choice",
  "components/studio/RegisterPanel.tsx": "the upload panel",
  "components/studio/GeneratePanel.tsx": "the generate panel",
  "components/studio/YourPassports.tsx": "the account's passports",
  "components/mine/OwnPictures.tsx": "/mine's grid",
  "lib/studio/useCreatorPassports.ts": "the index read behind both grids",
  "lib/data/passports.ts": "the passport list reads",
  // Only on the receipt with a stamp on it.
  "components/studio/Receipt.tsx": "the receipt's stamps, fees and sealed save",
  "lib/chain/fee.ts": "the gas bill on the receipt",
  // Only for the sealed and private switches, inside the panels.
  "components/studio/SealedFile.tsx": "the sealed switch, file card and done band",
  "components/sealed/SealSwitch.tsx": "the sealed and private switch",
  "components/sealed/SealedPlate.tsx": "the sealed plate",
  "components/sealed/Sketch.tsx": "the fingerprint sketch",
  // Only after a press.
  "components/studio/FailureNote.tsx": "what went wrong and what to do next",
  "components/studio/DoneActions.tsx": "the done screen's two ways on",
  "lib/passkey/browser.ts": "the passkey prompt",
  "lib/chain/calldata.ts": "the transaction bytes",
  "lib/verifier/client.ts": "the verify service calls",
} as const;

/** The packages the wallet brings, none of which may be on a page before it paints. */
const WALLET = ["@privy-io/react-auth", "@privy-io/wagmi", "wagmi", "@tanstack/react-query"];

describe("what the studio and /mine load before they paint", () => {
  const first = { studio: shipped(STUDIO), mine: shipped(MINE) };
  const all = { studio: shipped(STUDIO, true), mine: shipped(MINE, true) };

  it.each(Object.entries(MOVED))("the studio's first load holds no %s (%s)", (file) => {
    expect(first.studio.files).not.toContain(file);
  });

  it.each(Object.entries(MOVED).filter(([file]) => !file.startsWith("components/studio/LiveStudio")))(
    "/mine's first load holds no %s (%s)",
    (file) => {
      expect(first.mine.files).not.toContain(file);
    },
  );

  it("names no wallet package in either first load", () => {
    expect([...first.studio.packages].filter((name) => WALLET.includes(name))).toEqual([]);
    expect([...first.mine.packages].filter((name) => WALLET.includes(name))).toEqual([]);
  });

  it("still paints the waiting card and the empty stub from the first load", () => {
    for (const file of [
      "components/studio/StudioScreen.tsx",
      "components/studio/StudioFrame.tsx",
      "components/studio/layout.tsx",
      "components/studio/SignedOut.tsx",
      "components/studio/ReceiptFrame.tsx",
    ]) {
      expect(first.studio.files).toContain(file);
    }
    for (const file of ["components/mine/MineScreen.tsx", "components/mine/MineFrame.tsx", "components/mine/SignInCard.tsx"]) {
      expect(first.mine.files).toContain(file);
    }
  });

  it("reaches every moved module once the dynamic imports are followed, so the walk is not the pass", () => {
    for (const file of Object.keys(MOVED)) {
      if (file.startsWith("components/mine/") || file === "lib/data/passports.ts" || file === "lib/studio/useCreatorPassports.ts") {
        continue;
      }
      expect(all.studio.files, file).toContain(file);
    }
    for (const file of ["components/mine/MinePictures.tsx", "components/mine/OwnPictures.tsx", "lib/data/passports.ts"]) {
      expect(all.mine.files, file).toContain(file);
    }
    expect(all.studio.packages).toContain("@privy-io/react-auth");
    expect(all.mine.packages).toContain("@privy-io/react-auth");
  });
});

describe("what arrives with the wallet, and what waits for a sign in", () => {
  it("keeps the signed in cards and the stamped receipt out of the live studio's own chunk", () => {
    const live = shipped("@/components/studio/LiveStudio.tsx").files;
    expect(live).toContain("lib/studio/useStudio.ts");
    for (const file of [
      "components/studio/IdentityStrip.tsx",
      "components/studio/BindCard.tsx",
      "components/studio/RecoverCard.tsx",
      "components/studio/PathChoice.tsx",
      "components/studio/RegisterPanel.tsx",
      "components/studio/GeneratePanel.tsx",
      "components/studio/Receipt.tsx",
      "components/studio/SealedFile.tsx",
      "components/studio/FailureNote.tsx",
      "components/studio/DoneActions.tsx",
    ]) {
      expect(live, file).not.toContain(file);
    }
  });

  it("keeps the grid and its index reads out of /mine's signed out half", () => {
    const pictures = shipped("@/components/mine/MinePictures.tsx").files;
    expect(pictures).not.toContain("components/mine/OwnPictures.tsx");
    expect(pictures).not.toContain("lib/studio/useCreatorPassports.ts");
    expect(pictures).not.toContain("lib/data/passports.ts");
  });

  it("keeps the failure note and the done actions out of the panels until something is pressed", () => {
    for (const panel of ["RegisterPanel", "GeneratePanel", "BindCard", "RecoverCard"]) {
      const files = shipped(`@/components/studio/${panel}.tsx`).files;
      expect(files, panel).not.toContain("components/studio/FailureNote.tsx");
      expect(files, panel).not.toContain("components/studio/DoneActions.tsx");
    }
  });
});
