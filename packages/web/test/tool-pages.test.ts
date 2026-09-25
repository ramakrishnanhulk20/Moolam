import { describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";
import ta from "@/messages/ta.json";

/**
 * The tool pages after the design read of 25 September: the fixes that went
 * straight onto the real pages, and the compact openings that wait on the lab
 * page for Ram's yes.
 *
 * Layout is held here by the classes that make it, since a node test has no
 * boxes to measure. The boxes themselves were measured on the dev server, and
 * the numbers are in kitchen/reports/WO-155.txt.
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
// resolves inside a request. Here they read the English file directly.
function lookup(namespace: string | undefined, key: string, values?: Record<string, unknown>): string {
  const path = [...(namespace === undefined ? [] : namespace.split(".")), ...key.split(".")];
  let at: unknown = en;
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
  setRequestLocale: () => undefined,
}));

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
const { OPENING_WORDS } = await import("@/components/studio/openingWords");
const { StudioScreen } = await import("@/components/studio/StudioScreen");
const { MineScreen } = await import("@/components/mine/MineScreen");
const { WalletMounted } = await import("@/components/providers/WalletProvider");
const { default: OpeningsLabPage } = await import("@/app/[locale]/lab/openings/page");

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

describe("the compact openings on the lab page", () => {
  it("give the studio's sign-in card a card's heading, same words, no capitals", () => {
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

  it("leave today's studio card as it is", () => {
    const markup = render(createElement(WalletMounted.Provider, { value: false }, createElement(StudioScreen)));
    expect(tagOf(markup, "data-card-heading")).toContain("uppercase");
  });

  it("give My pictures the same card heading", () => {
    const markup = render(
      createElement(WalletMounted.Provider, { value: false }, createElement(MineScreen, { opening: "compact" })),
    );
    const heading = tagOf(markup, "data-card-heading");
    expect(heading).toContain('data-card-heading="card"');
    expect(heading).not.toContain("uppercase");
    expect(markup).toContain(en.mine.signedOut.heading);
  });

  it("put Explore's letter key behind one press on a phone, and nowhere else", () => {
    const search = { view: "pictures" as const, search: "", agent: null, ai: null };
    const compact = render(createElement(Filters, { search, opening: "compact" }));
    expect(tagOf(compact, "data-marks-toggle")).toContain("sm:hidden");
    expect(compact).toContain(OPENING_WORDS.marksToggle);
    expect(tagOf(compact, "data-marks-key")).toContain("hidden");
    expect(tagOf(compact, "data-marks-key")).toContain("sm:flex");

    const today = render(createElement(Filters, { search }));
    expect(today).not.toContain("data-marks-toggle");
    expect(tagOf(today, "data-marks-key")).not.toMatch(/\bhidden\b/);
  });

  it("fold Explore's four counts into one line on a phone", async () => {
    const counts = { total: 41, generated: 32, rechecked: 20, stated: 17, capped: false };
    const split = { real: 17, test: 24, scanned: 41, capped: false };
    const markup = renderToStaticMarkup(
      await ExploreMasthead({ locale: "en", counts, countsError: null, split, view: "pictures", opening: "compact" }),
    );
    expect(tagOf(markup, "data-counts-line")).toContain("sm:hidden");
    expect(markup).toContain(en.explore.counts.stated);

    const today = renderToStaticMarkup(
      await ExploreMasthead({ locale: "en", counts, countsError: null, split, view: "pictures" }),
    );
    expect(today).not.toContain("data-counts-line");
  });

  it("keep the new English words free of the long dash", () => {
    for (const words of Object.values(OPENING_WORDS)) {
      expect(words).not.toContain(LONG_DASH);
    }
  });

  it("are a 404 anywhere the lab flag is not set", async () => {
    const held = process.env.NEXT_PUBLIC_LAB_PAGES;
    delete process.env.NEXT_PUBLIC_LAB_PAGES;
    try {
      const thrown = await OpeningsLabPage({ params: Promise.resolve({ locale: "en" }) }).catch(
        (error: unknown) => error,
      );
      expect((thrown as { digest?: string }).digest).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
    } finally {
      if (held !== undefined) {
        process.env.NEXT_PUBLIC_LAB_PAGES = held;
      }
    }
  });
});
