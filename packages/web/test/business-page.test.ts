import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement, type FunctionComponent, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider, createTranslator } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "@/messages/en.json";
import { resolveDocsFile } from "@/lib/docs/files";
import { pageExists } from "@/lib/docs/pages";
import { docsRoot } from "@/lib/docs/paths";

/**
 * The business page as Ram picked it (WO-277a). The held reads behind it are
 * stubbed, so what is held here is that every figure and both attack numbers
 * come from their reads and move when the reads move, that the demo's picture
 * is the real passport's and falls back to a plain plate whenever any read
 * behind it fails, that every link goes somewhere real, that both themes have
 * their own shadows, and that no word on it carries a long dash.
 */

const stub = vi.hoisted(() => ({
  counts: vi.fn(),
  generator: vi.fn(),
  list: vi.fn(),
  record: vi.fn(),
  art: vi.fn(),
  agent: vi.fn(),
  transcript: { text: null as string | null },
}));

vi.mock("@/lib/data/passports", () => ({
  heldRegistryCounts: stub.counts,
  heldGeneratorRecord: stub.generator,
  heldArt: stub.art,
  heldHandover: vi.fn(),
}));

vi.mock("@/lib/chain/registry", () => ({
  heldPassportRecord: stub.record,
  heldAgent: stub.agent,
}));

vi.mock("@/lib/data/platform-label", async (original) => ({
  ...(await original<typeof import("@/lib/data/platform-label")>()),
  heldPlatformList: stub.list,
}));

// The transcript is the real file unless a test hands the page another one.
vi.mock("node:fs/promises", async (original) => {
  const real = await original<typeof import("node:fs/promises")>();
  const readFile = (async (file: string, encoding: BufferEncoding) =>
    String(file).endsWith("pass-kit.txt") && stub.transcript.text !== null
      ? stub.transcript.text
      : await real.readFile(file, encoding)) as typeof real.readFile;
  return { ...real, default: { ...real, readFile }, readFile };
});

// The real module pulls in Next's router, which does not load outside Next.
vi.mock("@/lib/i18n/routing", () => ({
  routing: { locales: ["en", "ta", "hi", "zh", "ja", "ko", "es", "fr", "de", "pt"], defaultLocale: "en" },
  Link: (props: { href: string; children?: ReactNode; className?: string }) =>
    createElement("a", { href: props.href, className: props.className }, props.children),
}));

vi.mock("next/image", () => ({
  default: (props: { src: string; alt?: string }) => createElement("img", { src: String(props.src), alt: props.alt ?? "" }),
}));

vi.mock("next-intl/server", () => ({
  setRequestLocale: () => undefined,
  getTranslations: async ({ namespace }: { locale: string; namespace: string }) =>
    createTranslator({ locale: "en", messages: en, namespace: namespace as "business.meta" }),
}));

const page = await import("@/app/[locale]/business/page");
const content = await import("@/components/business/content");
const data = await import("@/components/business/data");
const { DemoPicture } = await import("@/components/business/DemoPicture");

const WEB = fileURLToPath(new URL("..", import.meta.url));
const OWN_DIRS = [path.join(WEB, "components", "business"), path.join(WEB, "app", "[locale]", "business")];
const DREAMLOOM_WALLET = "0x80819a894AAa89e0346b715bEb897A7c2fda3F44";
const GATEWAY_IMAGE = "https://gateway.example/ipfs/bafymoon";
const REGISTERED = 1_790_769_500n;

function platform(name: string, agentId: bigint, origin: string, validTo: bigint | null = null) {
  return {
    name,
    agentId,
    ownerAtOnboarding: DREAMLOOM_WALLET,
    creatorWallet: DREAMLOOM_WALLET,
    keyHash: `0x${"92".repeat(32)}`,
    origins: [origin],
    validFrom: 1_790_768_921n,
    validTo,
    acceptedAt: 1_790_769_010n,
  };
}

function answer(figures: { total: number; stated: number | null; dreamloom: number; others: number }) {
  stub.counts.mockResolvedValue({ total: figures.total, generated: 0, rechecked: 0, stated: figures.stated, capped: false });
  stub.generator.mockResolvedValue({
    passportCount: figures.dreamloom,
    matchedCount: 0,
    mismatchedCount: 0,
    disputesUpheld: 0,
    trustScore: 0,
    firstSeenAt: 0n,
  });
  stub.list.mockResolvedValue({
    ok: true,
    platforms: [
      platform("Dreamloom", 10273n, content.DREAMLOOM_URL),
      // A replaced entry is not a platform on the list today.
      platform("Dreamloom", 10273n, content.DREAMLOOM_URL, 1_790_000_000n),
      ...Array.from({ length: figures.others }, (_, at) => platform(`Studio ${at}`, BigInt(20_000 + at), `https://studio-${at}.example`)),
    ],
  });
}

/** The demo passport as the registry holds it: made by Dreamloom's wallet, through its agent, with a manifest. */
function passportRecord(over: Partial<{ creator: string; generatorAgentId: bigint; disputed: boolean }> = {}) {
  return {
    passport: {
      id: content.DEMO_PASSPORT,
      creator: over.creator ?? DREAMLOOM_WALLET,
      kind: 0,
      generatorAgentId: over.generatorAgentId ?? 10273n,
      manifestHash: `0x${"ab".repeat(32)}`,
      registeredAt: REGISTERED,
      disputed: over.disputed ?? false,
      metadataURI: "ipfs://bafymeta",
    },
    attestations: [],
    edits: [],
    owner: null,
    dispute: null,
    hasPasskey: false,
  };
}

function render(node: ReactNode): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
    children: ReactNode;
  }>;
  return renderToStaticMarkup(createElement(Provider, { locale: "en", messages: en, timeZone: "UTC" }, node));
}

async function renderPage(theme: "light" | "dark" = "light"): Promise<string> {
  const node = await page.default({ params: Promise.resolve({ locale: "en" }) });
  // The theme is a class next-themes puts on the html element; the page itself is drawn once for both.
  return render(createElement("div", { className: theme }, node as ReactElement));
}

/** The words a reader sees: tags dropped and the entities React writes turned back. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

function sectionsOf(html: string): string[] {
  return [...html.matchAll(/data-section="([a-z]+)"/g)].map((found) => found[1]);
}

function liveFigure(html: string, key: string): string {
  const found = new RegExp(`data-live-figure="${key}"[^>]*>(.*?)</dd>`).exec(html);
  expect(found, key).not.toBeNull();
  return found![1].replace(/<[^>]+>/g, "");
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}

beforeEach(() => {
  for (const fn of [stub.counts, stub.generator, stub.list, stub.record, stub.art, stub.agent]) {
    fn.mockReset();
  }
  stub.transcript.text = null;
  answer({ total: 98_765, stated: 2_468, dreamloom: 4_321, others: 2 });
  stub.record.mockResolvedValue(passportRecord());
  stub.art.mockResolvedValue({ title: "A human standing alone in the moon.", imageUrl: GATEWAY_IMAGE, thumbnailUrl: GATEWAY_IMAGE, missing: false });
  stub.agent.mockResolvedValue({ owner: DREAMLOOM_WALLET });
});

afterEach(() => {
  stub.transcript.text = null;
});

describe("the route", () => {
  it("is built for all ten languages and rebuilt on the home page's minute", () => {
    const home = readFileSync(path.join(WEB, "app", "[locale]", "page.tsx"), "utf8");
    const homeMinute = Number(/export const revalidate = (\d+);/.exec(home)?.[1]);
    expect(homeMinute).toBeGreaterThan(0);
    expect(page.revalidate).toBe(homeMinute);
    expect(page.generateStaticParams().map((entry) => entry.locale)).toHaveLength(10);
  });

  it("takes its title and description from the messages and leaves the social card to the shared one", async () => {
    const meta = await page.generateMetadata({ params: Promise.resolve({ locale: "en" }) });
    expect(meta.title).toBe(en.business.meta.title);
    expect(meta.description).toBe(en.business.meta.description);
    expect(meta).not.toHaveProperty("openGraph");
  });
});

describe("the page", () => {
  it("draws drawing A in its order, in both themes", async () => {
    for (const theme of ["light", "dark"] as const) {
      const html = await renderPage(theme);
      expect(html).toContain(`class="${theme}"`);
      expect(sectionsOf(html)).toEqual(["hero", "why", "ways", "person", "build", "live", "pricing", "security", "call"]);
      expect(html).toContain("data-demo-loop");
      expect(html).not.toContain("data-drawing-switch");
      for (const words of [en.business.hero.headline, en.business.demo.press, en.business.demo.illustration, en.business.ways.recommended]) {
        expect(text(html)).toContain(words);
      }
    }
  });

  it("gives every heavy black shadow a light theme of its own", () => {
    const sources = OWN_DIRS.flatMap(files).filter((file) => file.endsWith(".tsx"));
    const classes = sources.flatMap((file) => [...readFileSync(file, "utf8").matchAll(/"[^"]*shadow-\[[^"]*rgb\(0_0_0[^"]*"/g)].map((found) => found[0]));
    expect(classes.length).toBeGreaterThan(2);
    for (const list of classes) {
      // The Moolam window inside the demo floats over the partner site's own dark veil, so it keeps its shadow.
      if (list.includes("w-[78%]")) continue;
      expect(list, list).toContain("[.light_&]:shadow-");
    }
  });

  it("takes every word from the business messages, so no sentence is typed into a component", () => {
    const sources = OWN_DIRS.flatMap(files).filter((file) => file.endsWith(".tsx"));
    for (const file of sources) {
      const body = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      // Text between tags that is not an expression: a sentence written straight into the markup.
      const loose = [...body.matchAll(/>\s*([A-Za-z][A-Za-z ,.']{3,})\s*</g)].map((found) => found[1]);
      expect(loose, file).toEqual([]);
    }
  });

  it("gives every link and button 44 px to a thumb", async () => {
    const html = await renderPage();
    const controls = [...html.matchAll(/<(a|button)\b[^>]*>/g)].map((found) => found[0]);
    expect(controls.length).toBeGreaterThan(10);
    for (const tag of controls) {
      expect(tag, tag).toMatch(/\b(min-h-11|h-11|min-h-14)\b/);
    }
  });
});

describe("the live figures", () => {
  it("print what the held index reads answer", async () => {
    const html = await renderPage();
    expect(liveFigure(html, "platform-passports")).toBe("4,321");
    expect(liveFigure(html, "total-passports")).toBe("98,765");
    expect(liveFigure(html, "stated")).toBe("2,468");
    expect(liveFigure(html, "platforms")).toBe("3");
    expect(stub.generator).toHaveBeenCalledWith(10273n);
  });

  it("move when the reads move, so none of them is typed into the page", async () => {
    answer({ total: 12, stated: 7, dreamloom: 5, others: 0 });
    const html = await renderPage();
    expect(liveFigure(html, "platform-passports")).toBe("5");
    expect(liveFigure(html, "total-passports")).toBe("12");
    expect(liveFigure(html, "stated")).toBe("7");
    expect(liveFigure(html, "platforms")).toBe("1");
    expect(text(html)).toContain("platform on Moolam's signed list");
  });

  it("print nothing for a read that failed, and keep the rest", async () => {
    stub.counts.mockRejectedValue(new Error("the Envio endpoint answered 503"));
    const read = await data.liveFigures();
    expect(read.totalPassports).toBeNull();
    expect(read.platformPassports).toBe(4_321);
    expect(read.errors).toContain("the Envio endpoint answered 503");

    const html = await renderPage();
    expect(liveFigure(html, "total-passports")).toContain(en.business.live.unread);
    expect(liveFigure(html, "platform-passports")).toBe("4,321");
  });
});

describe("the attack pass", () => {
  it("prints the numbers of the transcript's own tally line", async () => {
    const transcript = readFileSync(path.join(docsRoot, "..", "proofs", "attacks", "pass-kit.txt"), "utf8");
    const tally = data.parseTally(transcript);
    expect(tally).not.toBeNull();
    expect(tally!.refused + tally!.controls + tally!.findings).toBe(tally!.attacks);
    expect(await data.attackTally()).toEqual(tally);

    const block = /data-attack-tally[\s\S]*?<\/dl>/.exec(await renderPage())?.[0] ?? "";
    for (const figure of [tally!.attacks, tally!.refused, tally!.controls, tally!.findings]) {
      expect(block).toContain(`>${figure}<`);
    }
  });

  it("moves when the transcript does, and says it could not read one without the line", async () => {
    stub.transcript.text = "attacks 91: 80 REFUSED, 9 PASSED (positive controls), 2 NOT AS EXPECTED\n";
    const block = /data-attack-tally[\s\S]*?<\/dl>/.exec(await renderPage())?.[0] ?? "";
    for (const figure of [91, 80, 9, 2]) {
      expect(block).toContain(`>${figure}<`);
    }

    stub.transcript.text = "attacks were sent";
    const html = await renderPage();
    expect(html).not.toContain("data-attack-tally");
    expect(html).toContain("data-attack-unread");
    expect(text(html)).toContain(en.business.security.unread);
  });
});

describe("the demo's picture", () => {
  it("is the demo passport's own picture, read through the gateway list, with its title in the alt text", async () => {
    const picture = await data.demoPicture();
    expect(picture).toEqual({ id: content.DEMO_PASSPORT, title: "A human standing alone in the moon", sources: [GATEWAY_IMAGE] });
    expect(stub.record).toHaveBeenCalledWith(content.DEMO_PASSPORT);
    expect(stub.art).toHaveBeenCalledWith("ipfs://bafymeta", content.DEMO_PASSPORT);

    const html = await renderPage();
    expect(html).toContain(`data-demo-picture="${content.DEMO_PASSPORT}"`);
    expect(html).toContain(`src="${GATEWAY_IMAGE}"`);
    expect(html).toContain('alt="A human standing alone in the moon, a picture drawn on Dreamloom with its passport on Monad"');
    expect(html).not.toContain("data-demo-plain");
  });

  const fallbacks: [string, () => void][] = [
    ["the signed list is refused", () => stub.list.mockResolvedValue({ ok: false, platforms: [], reason: "the platform list did not load" })],
    ["the chain read fails", () => stub.record.mockRejectedValue(new Error("rpc answered 429"))],
    ["the registry has no such passport", () => stub.record.mockResolvedValue({ ...passportRecord(), passport: null })],
    ["a dispute is open on it", () => stub.record.mockResolvedValue(passportRecord({ disputed: true }))],
    ["another agent signed it", () => stub.record.mockResolvedValue(passportRecord({ generatorAgentId: 77n }))],
    [
      "nobody listed made it and the agent changed hands",
      () => {
        stub.record.mockResolvedValue(passportRecord({ creator: "0x1111111111111111111111111111111111111111" }));
        stub.agent.mockResolvedValue({ owner: "0x2222222222222222222222222222222222222222" });
      },
    ],
    ["the pinned document did not load", () => stub.art.mockResolvedValue({ missing: true })],
    ["the picture is sealed", () => stub.art.mockResolvedValue({ missing: false, sealed: true })],
    ["the document names no picture", () => stub.art.mockResolvedValue({ missing: false, title: "x" })],
  ];

  for (const [why, arrange] of fallbacks) {
    it(`falls back to the plain plate when ${why}`, async () => {
      arrange();
      expect(await data.demoPicture()).toBeNull();
      const html = await renderPage();
      expect(html).toContain('data-demo-picture="plain"');
      expect(html).toContain("data-demo-plain");
      expect(html).not.toContain("<img");
    });
  }

  it("draws the plain plate, never an empty image, when no gateway is left to ask", () => {
    const html = render(
      createElement(DemoPicture, { picture: { id: content.DEMO_PASSPORT, title: null, sources: [] }, sizes: "100vw" }),
    );
    expect(html).toContain("data-demo-plain");
    expect(html).not.toContain("<img");
  });
});

describe("every link", () => {
  const appRoutes = new Set(
    readdirSync(path.join(WEB, "app", "[locale]")).filter((name) => statSync(path.join(WEB, "app", "[locale]", name)).isDirectory()),
  );

  function headingIds(slug: string): Set<string> {
    const body = readFileSync(path.join(docsRoot, `${slug}.md`), "utf8");
    return new Set(
      [...body.matchAll(/^#{2,4} (.+)$/gm)].map((found) =>
        found[1]
          .toLowerCase()
          .replace(/[^\p{L}\p{N}\s-]/gu, "")
          .replace(/\s/g, "-"),
      ),
    );
  }

  for (const [key, href] of Object.entries(content.LINKS)) {
    it(`${key} goes somewhere real: ${href}`, () => {
      if (href.startsWith("https://")) {
        expect(href).toBe(content.DREAMLOOM_URL);
        return;
      }
      if (href.startsWith("/docs-files/")) {
        expect(resolveDocsFile(href.slice("/docs-files/".length).split("/"))).not.toBeNull();
        return;
      }
      if (href.startsWith("/docs/")) {
        const [slug, anchor] = href.slice("/docs/".length).split("#");
        expect(pageExists(slug)).toBe(true);
        if (anchor !== undefined) {
          expect(headingIds(slug).has(anchor), `#${anchor} on ${slug}`).toBe(true);
        }
        return;
      }
      expect(appRoutes.has(href.slice(1).split("/")[0])).toBe(true);
    });
  }

  it("is one of those, everywhere on the page", async () => {
    const html = await renderPage();
    const known = new Set<string>(Object.values(content.LINKS));
    // Anchors only: React also writes a preload line for the demo picture, which is not a link a reader follows.
    const hrefs = [...html.matchAll(/<a\s[^>]*\bhref="([^"]+)"/g)].map((found) => found[1].replace(/&amp;/g, "&"));
    expect(hrefs.length).toBeGreaterThan(5);
    for (const href of hrefs) {
      expect(known.has(href), href).toBe(true);
    }
  });
});

describe("the words", () => {
  const LONG_DASH = String.fromCharCode(0x2014);

  it("carry no long dash in any file of the page or in its messages", () => {
    const all = [...OWN_DIRS.flatMap(files), fileURLToPath(import.meta.url)];
    expect(all.length).toBeGreaterThan(8);
    for (const file of all) {
      expect(readFileSync(file, "utf8").includes(LONG_DASH), file).toBe(false);
    }
    for (const lang of ["en", "de", "es", "fr", "hi", "ja", "ko", "pt", "ta", "zh"]) {
      const messages = JSON.parse(readFileSync(path.join(WEB, "messages", `${lang}.json`), "utf8")) as { business: unknown };
      expect(JSON.stringify(messages.business).includes(LONG_DASH), lang).toBe(false);
    }
  });

  it("carry no long dash on the drawn page", async () => {
    expect(await renderPage()).not.toContain(LONG_DASH);
  });
});
