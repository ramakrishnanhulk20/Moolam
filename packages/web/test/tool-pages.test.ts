import { describe, expect, it, vi } from "vitest";
import { createElement, isValidElement, type FunctionComponent, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";
import ta from "@/messages/ta.json";

/**
 * The tool pages after the design read of 25 September: the fixes that went
 * straight onto the real pages, and the compact openings Ram said yes to, now
 * drawn on Verify, My pictures, Agents, the dispute page and Explore.
 *
 * Layout is held here by the classes that make it, since a node test has no
 * boxes to measure. The boxes themselves were measured on the dev server, and
 * the numbers are in kitchen/reports/WO-155.txt and WO-162.txt.
 */

process.env.NEXT_PUBLIC_PRIVY_APP_ID = "test-app-id";

vi.mock("@privy-io/react-auth", () => ({
  usePrivy: () => ({ ready: false, authenticated: false, user: null, login: () => undefined, logout: () => undefined }),
  useWallets: () => ({ wallets: [] }),
}));

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: Record<string, unknown>) =>
    createElement(
      "a",
      { href: props.href, className: props.className, "data-plate": props["data-plate"] },
      props.children as never,
    ),
  useRouter: () => ({ push: vi.fn(), refresh: () => undefined }),
}));

vi.mock("next/link", () => ({
  default: (props: { href: string; children?: unknown }) =>
    createElement("a", { href: props.href }, props.children as never),
  useLinkStatus: () => ({ pending: false }),
}));

vi.mock("@/components/passport/Picture", () => ({
  Picture: () => createElement("span", { "data-picture": "true" }),
}));

vi.mock("@/lib/images", () => ({ pictureSources: () => ["https://gateway.example/one.png"] }));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw Object.assign(new Error("NEXT_HTTP_ERROR_FALLBACK;404"), { digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
  },
}));

// The server halves read their words through next-intl/server, which only
// resolves inside a request. Here they read the language file the page asked
// for directly.
const request = vi.hoisted(() => ({ locale: "en" }));

function lookup(namespace: string | undefined, key: string, values?: Record<string, unknown>): string {
  const path = [...(namespace === undefined ? [] : namespace.split(".")), ...key.split(".")];
  let at: unknown = request.locale === "ta" ? ta : en;
  for (const part of path) {
    at = (at as Record<string, unknown> | undefined)?.[part];
  }
  if (typeof at !== "string") {
    throw new Error(`no message at ${path.join(".")}`);
  }
  return at.replace(/\{(\w+)\}/g, (_, name: string) => String(values?.[name] ?? ""));
}

vi.mock("next-intl/server", () => ({
  getTranslations: async (asked?: string | { namespace?: string }) => {
    const namespace = typeof asked === "string" ? asked : asked?.namespace;
    return (key: string, values?: Record<string, unknown>) => lookup(namespace, key, values);
  },
  getFormatter: async () => ({ dateTime: (date: Date) => date.toISOString().slice(0, 10) }),
  setRequestLocale: (locale: string) => {
    request.locale = locale;
  },
}));

// The reads each route makes on the server, handed fixed answers so the pages
// can be drawn here without a network.
const reads = vi.hoisted(() => ({
  showcase: null as unknown,
}));

vi.mock("next/server", () => ({ connection: async () => undefined }));

vi.mock("@/lib/data/offeredSamples", () => ({
  offeredSamples: async () => ({ samples: [{ id: `0x${"1a".repeat(32)}`, url: "ipfs://one", title: "Monsoon" }], error: null }),
}));

vi.mock("@/lib/chain/registry", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  resolver: async () => `0x${"55".repeat(20)}`,
}));

vi.mock("@/lib/disputes/queue", () => ({ openDisputeQueue: async () => [] }));

vi.mock("@/components/studio/showcasePassport", () => ({ showcasePassport: async () => reads.showcase }));

const chunks = vi.hoisted(() => ({ pending: [] as Promise<unknown>[] }));

vi.mock("next/dynamic", () => ({
  default: (load: () => Promise<FunctionComponent<never>>) => {
    let Panel: FunctionComponent<never> | null = null;
    chunks.pending.push(
      load().then((component) => {
        Panel = component;
      }),
    );
    return (props: never) => (Panel === null ? null : createElement(Panel, props));
  },
}));

const { Plate } = await import("@/components/explore/Plate");
const { Filters } = await import("@/components/explore/Filters");
const { Masthead: ExploreMasthead } = await import("@/components/explore/Masthead");
const { isTestCard, sortPlates } = await import("@/components/explore/sort");
const { Row } = await import("@/components/agents/Row");
const { ResolveConsole } = await import("@/components/resolve/ResolveConsole");
const { Masthead: DocsMasthead } = await import("@/components/docs/Masthead");
const { ThemeProvider, themeScriptType } = await import("@/components/providers/ThemeProvider");
const { OpeningProvider } = await import("@/components/studio/opening");
const { StudioScreen } = await import("@/components/studio/StudioScreen");
const { WalletMounted } = await import("@/components/providers/WalletProvider");
const { Board } = await import("@/components/agents/Board");
const { default: VerifyPage } = await import("@/app/[locale]/verify/page");
const { default: MinePage } = await import("@/app/[locale]/mine/page");
const { default: ResolvePage } = await import("@/app/[locale]/resolve/page");

await Promise.all(chunks.pending);

/** The long dash this repo never writes, built from its code point so this file does not carry one. */
const LONG_DASH = String.fromCodePoint(0x2014);

function render(node: ReactElement, locale: "en" | "ta" = "en"): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;
  return renderToStaticMarkup(
    createElement(Provider, { locale, messages: locale === "en" ? en : ta, timeZone: "Asia/Kolkata" }, node),
  );
}

/**
 * A route's server component, with every async server component under it
 * awaited, so the string renderer can draw the client parts the way the server
 * would.
 */
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
  // A drawing handed in as a prop, like the passport beside the sign-in card,
  // is awaited the same way the children are.
  const props: Record<string, unknown> = { ...element.props, key: (node as { key?: string }).key };
  for (const [name, value] of Object.entries(element.props)) {
    if (name !== "children" && isValidElement(value)) {
      props[name] = await settle(value);
    }
  }
  if (element.props.children === undefined) {
    return createElement(element.type as string, props);
  }
  const children = await settle(element.props.children);
  return createElement(element.type as string, props, children);
}

/** The same text as it appears in HTML, with the characters React escapes. */
function html(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}

async function serve(page: Promise<ReactNode> | ReactNode, locale: "en" | "ta" = "en"): Promise<string> {
  try {
    return render((await settle(await page)) as ReactElement, locale);
  } finally {
    request.locale = "en";
  }
}

/** The opening tag of the first element carrying this data attribute. */
function tagOf(markup: string, attribute: string): string {
  const at = markup.indexOf(attribute);
  expect(at, `${attribute} is on the page`).toBeGreaterThan(-1);
  const opens = markup.lastIndexOf("<", at);
  return markup.slice(opens, markup.indexOf(">", at) + 1);
}

const IPHONE = "0x864c33c6806185d4dc7acd65f465fc4c3cb6b8faaa157c32880cbef9dd93fc09";
const OLD_BUT_STRONG = "0x980549624f85e4ef47043383c5a746cbdd1d82797b5b5583e1f5aeb3841d010c";

const plate = {
  id: `0x${"1a".repeat(32)}`,
  kind: 0,
  registeredAt: 1_788_876_082,
  title: "Monsoon fishing nets drying",
  thumbnailUrl: "ipfs://picture-1",
  manifest: true,
  rechecked: true,
  chainlink: true,
  disputed: false,
  agentId: "10249",
  consent: { summary: "closed" as const, at: 1_788_876_100, uses: {
    aiTraining: "notAllowed" as const,
    aiGenerativeTraining: "notAllowed" as const,
    aiInference: "unspecified" as const,
    dataMining: "unspecified" as const,
  } },
};

const sealed = {
  ...plate,
  id: `0x${"2b".repeat(32)}`,
  title: "Kanchipuram Silk Loom at First Light",
  thumbnailUrl: null,
  sealed: true,
  blockhash: `0x${"a5".repeat(32)}`,
};

describe("the kind and the letters on a plate", () => {
  for (const locale of ["en", "ta"] as const) {
    it(`are two cells of one grid, never one row pushed apart (${locale})`, () => {
      const markup = render(createElement(Plate, { plate }), locale);
      const top = tagOf(markup, "data-plate-top=");

      expect(top).toContain("grid");
      expect(top).toContain("grid-cols-1");
      // Side by side only on a plate wide enough to hold both, which a phone's is not.
      expect(top).toContain("@[17rem]:grid-cols-[minmax(0,1fr)_auto]");
      expect(top).not.toContain("justify-between");
      expect(tagOf(markup, "data-plate-kind")).toContain("min-w-0");
      expect(tagOf(markup, "data-plate-marks")).toContain("shrink-0");
      // The plate is the container the two widths are measured against.
      expect(tagOf(markup, "data-plate=")).toContain("@container");
      expect(markup).toContain(locale === "en" ? en.kind["0"] : ta.kind["0"]);
    });
  }

  it("gives the top of a bright picture a quiet scrim, as its foot already has", () => {
    const top = tagOf(render(createElement(Plate, { plate })), "data-plate-top-scrim");
    expect(top).toContain("top-0");
    expect(top).toContain("var(--scrim-from)");
    expect(top).toContain("opacity-80");
  });
});

describe("a sealed plate", () => {
  const markup = render(createElement(Plate, { plate: sealed }));

  it("is a column, so the drawing takes only the height the words leave it", () => {
    expect(tagOf(markup, "data-plate=")).toContain("flex flex-col");
    expect(tagOf(markup, "data-sealed-drawing")).toContain("flex-1");
    expect(tagOf(markup, "data-sealed-drawing")).toContain("min-h-0");
  });

  it("puts the title, the id and the date on a ground of their own, in the flow and not over the drawing", () => {
    const foot = tagOf(markup, "data-plate-foot");
    expect(foot).toContain("relative");
    expect(foot).toContain("bg-bg-raised");
    expect(foot).not.toContain("absolute");
    expect(markup.indexOf("data-sealed-drawing")).toBeLessThan(markup.indexOf("data-plate-foot"));
    expect(markup.indexOf("Kanchipuram Silk Loom at First Light")).toBeGreaterThan(markup.indexOf("data-plate-foot"));
  });

  it("keeps its marks in the flow too, ahead of the drawing, so nothing is drawn over the cells", () => {
    const top = tagOf(markup, "data-plate-top=");
    expect(top).not.toContain("absolute");
    expect(markup.indexOf("data-plate-top=")).toBeLessThan(markup.indexOf("data-sealed-drawing"));
  });

  it("keeps the drawing square in whichever direction runs out first", () => {
    expect(markup).toContain("h-[min(100cqw,100cqh)] w-[min(100cqw,100cqh)]");
    expect(tagOf(markup, "data-sealed-drawing")).toContain("[container-type:size]");
  });

  it("still says sealed in words", () => {
    expect(markup).toContain(en.explore.sealed.word);
  });
});

describe("Ram's two uploads", () => {
  it("are test cards by id, whatever their titles say", () => {
    expect(isTestCard("Iphone 18 pro max", IPHONE)).toBe(true);
    expect(isTestCard("Old but strong", OLD_BUT_STRONG)).toBe(true);
    expect(isTestCard("Old but strong", OLD_BUT_STRONG.toUpperCase().replace("0X", "0x"))).toBe(true);
  });

  it("leave every other picture with a real title a picture", () => {
    expect(isTestCard("Old but strong", `0x${"3c".repeat(32)}`)).toBe(false);
    expect(isTestCard("Monsoon Fishing Nets Drying", `0x${"cd".repeat(32)}`)).toBe(false);
  });

  it("keep the title rule for callers that have no id", () => {
    expect(isTestCard("Moolam seed 4")).toBe(true);
    expect(isTestCard("Iphone 18 pro max")).toBe(false);
  });

  it("sort behind the real pictures, so the chips, the counts and the order agree", () => {
    const sorted = sortPlates([
      { id: IPHONE, registeredAt: 300, title: "Iphone 18 pro max" },
      { id: OLD_BUT_STRONG, registeredAt: 200, title: "Old but strong" },
      { id: `0x${"4d".repeat(32)}`, registeredAt: 100, title: "Ant and Elephants" },
    ]);
    expect(sorted.map((row) => row.title)).toEqual(["Ant and Elephants", "Iphone 18 pro max", "Old but strong"]);
  });

  it("wear the test card word on their plates", () => {
    const markup = render(createElement(Plate, { plate: { ...plate, id: IPHONE, title: "Iphone 18 pro max" } }));
    expect(markup).toContain(en.explore.seedCard);
  });
});

describe("an agent's name on the board", () => {
  const agent = {
    id: "10249",
    name: "Moolam generator on a Privy server wallet",
    firstSeenAt: 1_788_876_082,
    trustScore: 95,
    passportCount: 24,
    matchedCount: 18,
    mismatchedCount: 0,
    disputesUpheld: 0,
  };

  it("is set small enough for the longest name to take two lines on a laptop and three on a phone", () => {
    const heading = tagOf(render(createElement(Row, { agent: agent as never, place: 0 })), "data-agent-name");
    expect(heading).toContain("font-display");
    expect(heading).toContain("uppercase");
    // 2.1rem at most, against 2.9rem before; measured on the dev server at two
    // lines for 1440 and at 375.
    expect(heading).toContain("text-[clamp(1.35rem,2.6vw,2.1rem)]");
    expect(heading).toContain("max-w-[26ch]");
  });
});

describe("what the registry owes you, before it is read", () => {
  it("is a small status line, not a headline", () => {
    const markup = render(createElement(ResolveConsole, { resolver: `0x${"55".repeat(20)}` as `0x${string}`, disputes: [] }));
    const unread = tagOf(markup, "data-credit-unread");
    expect(unread).toContain("font-mono");
    expect(unread).toContain("text-[11px]");
    expect(unread).not.toContain("font-display");
    expect(markup).toContain(en.resolve.creditUnread);
    expect(markup).not.toContain("data-credit-amount");
  });
});

describe("the word Documentation", () => {
  it("is left to the bar beside the search box on a laptop, and kept on a phone, on a page outside any group", async () => {
    const markup = renderToStaticMarkup(await DocsMasthead({ section: null, title: "Moolam" }));
    expect(tagOf(markup, "data-docs-kicker")).toContain("lg:hidden");
    expect(markup).toContain(en.docs.home);
  });

  it("stays on a page inside a group, where the kicker is the group's name", async () => {
    const markup = renderToStaticMarkup(await DocsMasthead({ section: "Concepts", title: "How it works" }));
    expect(tagOf(markup, "data-docs-kicker")).not.toContain("lg:hidden");
  });
});

describe("the theme script", () => {
  it("is a script in the server's HTML, so the saved theme lands before first paint", () => {
    expect(themeScriptType()).toBe("text/javascript");
    const markup = renderToStaticMarkup(createElement(ThemeProvider, null, createElement("main")));
    expect(markup).toContain('<script type="text/javascript"');
  });

  it("is plain text when React draws it in a browser, which is what stopped the 404's console warning", () => {
    const held = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {};
    try {
      expect(themeScriptType()).toBe("text/plain");
    } finally {
      (globalThis as { window?: unknown }).window = held;
    }
  });
});

describe("the studio's sign-in card under the compact opening", () => {
  it("is a card's heading, same words, no capitals", () => {
    const markup = render(
      createElement(
        WalletMounted.Provider,
        { value: false },
        createElement(OpeningProvider, { opening: "compact" }, createElement(StudioScreen)),
      ),
    );
    const heading = tagOf(markup, "data-card-heading");
    expect(heading).toContain('data-card-heading="card"');
    expect(heading).not.toContain("uppercase");
    expect(markup).toContain(en.studio.signedOut.heading);
  });

  it("leaves today's studio card as it is until the studio's own order", () => {
    const markup = render(createElement(WalletMounted.Provider, { value: false }, createElement(StudioScreen)));
    expect(tagOf(markup, "data-card-heading")).toContain("uppercase");
  });
});

/** The first element in the markup whose class list starts with this. */
function classAt(markup: string, pattern: RegExp): string[] {
  const found = markup.match(pattern);
  expect(found, `${String(pattern)} is on the page`).not.toBeNull();
  return (found as RegExpMatchArray)[1].split(/\s+/);
}

/** The classes that only apply from 640 px up: what a laptop draws. */
function wide(classes: string[]): string[] {
  return classes.filter((name) => name.startsWith("sm:") || name.startsWith("lg:") || name.startsWith("xl:")).sort();
}

describe("the compact openings on the real routes", () => {
  for (const locale of ["en", "ta"] as const) {
    const words = locale === "en" ? en : ta;

    it(`Verify opens short, with the drop box right under it (${locale})`, async () => {
      const markup = await serve(VerifyPage({ params: Promise.resolve({ locale }) }), locale);
      const opening = tagOf(markup, "data-opening");
      expect(opening).toContain('data-opening="compact"');
      expect(markup).toContain(html(words.verify.title));
      expect(markup).toContain(html(words.verify.lede));
      expect(tagOf(markup, "data-verify-tool")).toContain("mt-7");
      expect(tagOf(markup, "data-verify-tool")).not.toContain("mt-16");
      expect(markup.indexOf("data-opening")).toBeLessThan(markup.indexOf("data-verify-tool"));
      // The poster-sized title and the vertical rail are gone from the route.
      expect(markup).not.toContain("clamp(2.6rem,8.5vw,6.5rem)");
      expect(markup).not.toContain("vertical-rl");
      expect(markup).toContain('data-verify-samples');
      expect(tagOf(markup, "data-verify-samples")).toContain("mt-5");
    });

    it(`My pictures signed out puts the sign-in card beside a real passport (${locale})`, async () => {
      reads.showcase = {
        id: `0x${"c4".repeat(32)}`,
        title: "Monsoon fishing nets drying",
        picture: "ipfs://picture-1",
        creator: `0x${"12".repeat(20)}`,
        agentId: "10249",
        agentName: "Moolam generator",
        statement: "closed",
        recheck: null,
      };
      try {
        const markup = await serve(MinePage({ params: Promise.resolve({ locale }) }), locale);
        expect(tagOf(markup, "data-opening")).toContain('data-opening="compact"');
        expect(markup).toContain(html(words.mine.heading));

        const split = tagOf(markup, "data-sign-in-split");
        expect(split).toContain("lg:[&amp;:has([data-signed-out])]:grid-cols-[minmax(0,44rem)_minmax(0,1fr)]");
        expect(split).toContain("[&amp;:not(:has([data-signed-out]))&gt;[data-showcase-slot]]:hidden");

        const heading = tagOf(markup, "data-card-heading");
        expect(heading).toContain('data-card-heading="card"');
        expect(heading).not.toContain("uppercase");
        expect(tagOf(markup, "data-signed-out")).not.toContain("mt-16");

        expect(markup).toContain("data-showcase");
        expect(markup).toContain(html(words.mine.showcaseCaption));
        expect(markup).toContain("Monsoon fishing nets drying");
        // The card comes first, the passport beside it.
        expect(markup.indexOf("data-signed-out")).toBeLessThan(markup.indexOf("data-showcase-slot"));
      } finally {
        reads.showcase = null;
      }
    });

    it(`My pictures stands the card alone when no passport could be read (${locale})`, async () => {
      const markup = await serve(MinePage({ params: Promise.resolve({ locale }) }), locale);
      expect(markup).toContain("data-signed-out");
      expect(markup).not.toContain("data-showcase=");
    });

    it(`Agents puts the explainer beside the title and the ledger right under it (${locale})`, async () => {
      const agent = {
        id: "10249",
        name: "Moolam generator on a Privy server wallet",
        firstSeenAt: 1_788_876_082,
        trustScore: 95,
        passportCount: 24,
        matchedCount: 18,
        mismatchedCount: 0,
        disputesUpheld: 0,
      };
      // The board is not a route, so nothing sets the request's language for it.
      request.locale = locale;
      const markup = await serve(Board({ agents: [agent as never], error: null, locale }), locale);
      expect(tagOf(markup, "data-opening")).toContain('data-opening="compact"');
      const explainer = tagOf(markup, "data-agents-explainer");
      expect(explainer).toContain("lg:justify-self-end");
      expect(markup).toContain(html(words.agents.scoreMeaning));
      expect(markup).toContain(html(words.agents.formulaHow));
      // The explainer sits inside the opening, and the first agent follows it.
      expect(markup.indexOf("data-agents-explainer")).toBeLessThan(markup.indexOf("</header>"));
      expect(markup.indexOf("</header>")).toBeLessThan(markup.indexOf("data-agent-name"));
      expect(markup).toMatch(/<\/header><ul>/);
      expect(markup).not.toContain("vertical-rl");
    });

    it(`the dispute page opens short, with both cards right under it (${locale})`, async () => {
      const markup = await serve(ResolvePage({ params: Promise.resolve({ locale }) }), locale);
      expect(tagOf(markup, "data-opening")).toContain('data-opening="compact"');
      expect(markup).toContain(html(words.resolve.heading));
      const desk = tagOf(markup, "data-resolve-desk");
      expect(desk).toContain("mt-7");
      expect(desk).not.toContain("mt-14");
      expect(markup).not.toContain("vertical-rl");
    });
  }

  it("put Explore's letter key behind one press on a phone, and keep it open from 640 px up", () => {
    const search = { view: "pictures" as const, search: "", agent: null, ai: null };
    const markup = render(createElement(Filters, { search }));
    expect(tagOf(markup, "data-marks-toggle")).toContain("sm:hidden");
    expect(markup).toContain(en.explore.marksToggle);
    expect(tagOf(markup, "data-marks-key")).toMatch(/\bhidden\b/);
    expect(tagOf(markup, "data-marks-key")).toContain("sm:flex");
    // The chips and the AI row keep their sm values, so a laptop's bar is today's.
    expect(wide(classAt(markup, /<div class="([^"]*border-y border-line[^"]*)"/))).toEqual(["sm:mt-10", "sm:py-5"]);
  });

  it("fold Explore's four counts into one line on a phone", async () => {
    const counts = { total: 41, generated: 32, rechecked: 20, stated: 17, capped: false };
    const split = { real: 17, test: 24, scanned: 41, capped: false };
    const markup = renderToStaticMarkup(
      await ExploreMasthead({ locale: "en", counts, countsError: null, split, view: "pictures" }),
    );
    expect(tagOf(markup, "data-counts-line")).toContain("sm:hidden");
    expect(markup).toContain(en.explore.counts.stated);
    const grid = tagOf(markup, "data-counts-grid");
    expect(grid).toMatch(/\bhidden\b/);
    expect(grid).not.toContain("grid-cols-2 sm:");
  });

  it("leave Explore's laptop masthead exactly as it was", async () => {
    const counts = { total: 41, generated: 32, rechecked: 20, stated: 17, capped: false };
    const split = { real: 17, test: 24, scanned: 41, capped: false };
    const markup = renderToStaticMarkup(
      await ExploreMasthead({ locale: "en", counts, countsError: null, split, view: "pictures" }),
    );

    // The classes from 640 px up, as they were before the phone opening came in.
    expect(wide(classAt(markup, /<div class="(grid gap-x-16[^"]*)"/))).toEqual(
      ["lg:grid-cols-[minmax(0,1.25fr)_minmax(0,0.75fr)]", "lg:items-end", "sm:gap-y-10"].sort(),
    );
    expect(wide(classAt(markup, /<h1 class="([^"]*)"/))).toEqual(["sm:mt-6", "sm:text-[clamp(2.4rem,8.5vw,6.5rem)]"]);
    expect(wide(classAt(markup, new RegExp(`<p class="([^"]*)"[^>]*>${en.explore.lede.slice(0, 20)}`)))).toEqual([
      "sm:mt-7",
      "sm:text-lg",
    ]);
    expect(wide(classAt(markup, /<div class="(rise sm:border-t[^"]*)"/))).toEqual(
      [
        "sm:border-t",
        "sm:border-line",
        "sm:pt-6",
        "lg:border-t-0",
        "lg:border-s",
        "lg:border-line",
        "lg:pt-0",
        "lg:ps-12",
      ].sort(),
    );
    expect(wide(tagOf(markup, "data-counts-grid").match(/class="([^"]*)"/)?.[1].split(" ") ?? [])).toEqual(
      ["sm:grid", "sm:grid-cols-4", "lg:grid-cols-2"].sort(),
    );
    expect(wide(classAt(markup, /<p class="([^"]*tracking-\[0\.2em\][^"]*)"/))).toEqual(["sm:mt-10"]);

    // Every phone value that changed has a laptop value beside it that wins from 640 px.
    const title = classAt(markup, /<h1 class="([^"]*)"/);
    expect(title).toContain("mt-2.5");
    expect(title).toContain("text-[clamp(1.75rem,8vw,2.25rem)]");
  });

  it("keep the openings' words free of the long dash in every language they ship in", () => {
    for (const messages of [en, ta]) {
      for (const words of [messages.explore.marksToggle, messages.studio.showcaseCaption, messages.mine.showcaseCaption]) {
        expect(words).not.toContain(LONG_DASH);
      }
    }
  });
});
