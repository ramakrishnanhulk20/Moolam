import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync } from "node:fs";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";
import ta from "@/messages/ta.json";
import type { CreatorPassports } from "@/lib/studio/useCreatorPassports";
import type { Studio } from "@/lib/studio/useStudio";
import { initialRegisterState } from "@/lib/studio/flow";
import { MINE_KEYS } from "./mine-keys.mjs";

/**
 * The page a signed in person lands on from the bar, the way out of the studio
 * receipt that points at it, and the words both of them need in ten languages.
 *
 * A sign in cannot be driven from a test, so Privy is stood in for and the
 * index read is handed a fixture. What is really being checked is the page's
 * three states: nothing to show until someone signs in, the wait while the
 * wallet lands, and the grid once an address is known.
 */

// Set before the imports run, because the module that reads it checks once on
// import and the page says "not configured" without it.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_PRIVY_APP_ID = "test-app-id";
});

const privy = vi.hoisted(() => ({
  session: { ready: true, authenticated: false, login: () => undefined },
  wallets: [] as { walletClientType: string; address: string }[],
}));

vi.mock("@privy-io/react-auth", () => ({
  usePrivy: () => privy.session,
  useWallets: () => ({ wallets: privy.wallets }),
}));

/** The hook's answer with nothing in it, and nothing left to read. */
const EMPTY = vi.hoisted(
  () =>
    ({
      status: "ready",
      passports: [],
      error: null,
      refresh: () => undefined,
      hasMore: false,
      loadingMore: false,
      moreError: null,
      more: () => undefined,
    }) as CreatorPassports,
);

const list = vi.hoisted(() => ({ current: EMPTY }));

vi.mock("@/lib/studio/useCreatorPassports", () => ({ useCreatorPassports: () => list.current }));

// next-intl's navigation helpers reach for next/navigation, which only resolves
// inside the bundler. The link is the one thing these screens use from it.
vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
}));

// The signed in half of the page and its grid reach the screen through
// next/dynamic, which hands a component back only once its chunk has arrived.
// Every loader is started here and awaited below, so the cases render the grid
// and not the waiting card that stands in while it loads.
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

const { MineScreen } = await import("@/components/mine/MineScreen");
const { hasPassportEnd, passportEnd, passportEndClasses } = await import("@/components/studio/passportsEnd");
const { Receipt } = await import("@/components/studio/Receipt");
const { WalletMounted } = await import("@/components/providers/WalletProvider");
const { default: robots } = await import("@/app/robots");
const { pagePaths } = await import("@/app/sitemap");

for (let seen = -1; seen !== chunks.pending.length; ) {
  seen = chunks.pending.length;
  await Promise.all(chunks.pending);
}

/** A file in this package, read from the directory vitest runs in. */
function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** The screen as a reader gets it, in one of the two languages this file checks the words in. */
function render(locale: "en" | "ta", node: ReactElement, mounted = true): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;

  return renderToStaticMarkup(
    createElement(
      Provider,
      { locale, messages: locale === "en" ? en : ta, timeZone: "Asia/Kolkata" },
      createElement(WalletMounted.Provider, { value: mounted }, node),
    ),
  );
}

const PASSPORT = {
  id: `0x${"ab".repeat(32)}` as const,
  kind: 1,
  registeredAt: 1_788_876_542n,
  registeredBlock: 103_059_393n,
  metadataURI: "ipfs://metadata",
  title: "A hill at first light",
  imageUrl: "https://gateway/image",
};

describe("the page a person finds their own pictures on", () => {
  beforeEach(() => {
    privy.session = { ready: true, authenticated: false, login: () => undefined };
    privy.wallets = [];
    list.current = EMPTY;
  });

  it("asks a signed out reader to sign in, and says what for", () => {
    const markup = render("en", createElement(MineScreen));
    expect(markup).toContain(en.mine.signedOut.heading);
    expect(markup).toContain(en.mine.signedOut.button);
    expect(markup).not.toContain(en.mine.grid);
  });

  it("says the same thing in Tamil", () => {
    const markup = render("ta", createElement(MineScreen));
    expect(markup).toContain(ta.mine.signedOut.heading);
    expect(markup).toContain(ta.mine.signedOut.button);
  });

  it("waits on the wallet with the card already at its full height", () => {
    const markup = render("en", createElement(MineScreen), false);
    expect(markup).toContain(en.mine.opening);
    expect(markup).toContain(en.mine.signedOut.heading);
    expect(markup).toContain('aria-busy="true"');
  });

  it("shows the account's pictures, newest first, each one linking to its passport", () => {
    privy.session = { ready: true, authenticated: true, login: () => undefined };
    privy.wallets = [{ walletClientType: "privy", address: `0x${"11".repeat(20)}` }];
    list.current = { ...EMPTY, passports: [PASSPORT] };

    const markup = render("en", createElement(MineScreen));
    expect(markup).toContain(en.mine.grid);
    expect(markup).toContain("A hill at first light");
    expect(markup).toContain(`href="/passport/${PASSPORT.id}"`);
    expect(markup).toContain(en.studio.passports.source);
  });

  it("keeps the studio's own empty state for an account with nothing in it", () => {
    privy.session = { ready: true, authenticated: true, login: () => undefined };
    privy.wallets = [{ walletClientType: "privy", address: `0x${"11".repeat(20)}` }];

    const markup = render("en", createElement(MineScreen));
    expect(markup).toContain(en.studio.passports.empty);
    expect(markup).not.toContain(en.explore.loadMore);
  });
});

describe("every picture, not only the newest twelve", () => {
  beforeEach(() => {
    privy.session = { ready: true, authenticated: true, login: () => undefined };
    privy.wallets = [{ walletClientType: "privy", address: `0x${"11".repeat(20)}` }];
  });

  it("offers Load more under the grid while the index holds older pictures", () => {
    list.current = { ...EMPTY, passports: [PASSPORT], hasMore: true };

    const markup = render("en", createElement(MineScreen));
    expect(markup).toContain(`>${en.explore.loadMore}</button>`);
    expect(markup.indexOf(en.explore.loadMore)).toBeGreaterThan(markup.indexOf("A hill at first light"));
  });

  it("says it in Tamil too", () => {
    list.current = { ...EMPTY, passports: [PASSPORT], hasMore: true };
    expect(render("ta", createElement(MineScreen))).toContain(`>${ta.explore.loadMore}</button>`);
  });

  it("offers nothing more once the last page is on screen", () => {
    list.current = { ...EMPTY, passports: [PASSPORT], hasMore: false };
    expect(render("en", createElement(MineScreen))).not.toContain(en.explore.loadMore);
  });

  it("shows the wait on the button itself, and takes no second press", () => {
    list.current = { ...EMPTY, passports: [PASSPORT], hasMore: true, loadingMore: true };

    const markup = render("en", createElement(MineScreen));
    const button = markup.slice(markup.lastIndexOf("<button"), markup.lastIndexOf("</button>"));
    expect(button).toContain(en.explore.loading);
    expect(button).toContain("disabled");
    expect(button).toContain('aria-busy="true"');
    expect(markup).toContain("A hill at first light");
  });

  it("keeps the pictures already read when the next page fails, and says why beside the press", () => {
    list.current = {
      ...EMPTY,
      passports: [PASSPORT],
      hasMore: true,
      moreError: "the Envio endpoint answered 429",
    };

    const markup = render("en", createElement(MineScreen));
    expect(markup).toContain("A hill at first light");
    expect(markup).toContain(`>${en.explore.loadMore}</button>`);
    // The sentence in the reader's words, and the index's own only inside the fold (WO-229 step 4).
    expect(markup).toContain(en.studio.passports.unreadable);
    expect(markup).toMatch(/<details data-failure-details[\s\S]*the Envio endpoint answered 429[\s\S]*<\/details>/);
  });

  it("offers no press while the first page is still being read or could not be", () => {
    list.current = { ...EMPTY, status: "reading", hasMore: true };
    expect(render("en", createElement(MineScreen))).not.toContain(en.explore.loadMore);

    list.current = { ...EMPTY, status: "unreadable", error: "down", hasMore: true };
    expect(render("en", createElement(MineScreen))).not.toContain(en.explore.loadMore);
  });
});

describe("the grid is the studio's, closed the same way", () => {
  beforeEach(() => {
    privy.session = { ready: true, authenticated: true, login: () => undefined };
    privy.wallets = [{ walletClientType: "privy", address: `0x${"11".repeat(20)}` }];
  });

  const cards = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ ...PASSPORT, id: `0x${String(index).padStart(64, "0")}` as const }));

  it.each([1, 2, 3, 4, 5])("closes a short last row with %i cards at two, three and four columns", (count) => {
    list.current = { ...EMPTY, passports: cards(count) };
    const markup = render("en", createElement(MineScreen));
    const end = passportEnd(count);

    expect(markup).toContain("sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4");
    expect(markup.match(/<li/g)?.length).toBe(hasPassportEnd(end) ? count + 1 : count);
    if (hasPassportEnd(end)) {
      const cell = /<li[^>]*data-passports-end[^>]*>/.exec(markup)?.[0] ?? "";
      expect(cell).toContain(passportEndClasses(end));
      expect(cell).toContain('aria-hidden="true"');
    } else {
      expect(markup).not.toContain("data-passports-end");
    }
  });

  it("offers one Load more, not the grid's and a copy of its own", () => {
    list.current = { ...EMPTY, passports: cards(5), hasMore: true };
    const markup = render("en", createElement(MineScreen));
    expect(markup.split(`>${en.explore.loadMore}</button>`)).toHaveLength(2);
  });

  it("draws the sign-in split from the studio's own file", () => {
    const page = read("app/[locale]/mine/page.tsx");
    expect(page).toContain('import { SignInSplit } from "@/components/studio/SignInSplit"');
    expect(page).not.toContain("function SignInSplit");
  });
});

describe("the studio's foot keeps its short list", () => {
  it("still calls the hook with no page size, so it reads the newest twelve", () => {
    const studio = read("lib/studio/useStudio.ts");
    expect(studio).toMatch(/useCreatorPassports\(authenticated \? wallet : undefined\)/);
    expect(read("lib/studio/useCreatorPassports.ts")).toContain("pageSize = 12");
  });
});

/** A run that has landed, which is the only state the receipt offers a way out of. */
function receipt(over: Record<string, unknown> = {}): Studio {
  return {
    authenticated: true,
    account: { kind: "email", value: "ram@example.com" },
    wallet: `0x${"11".repeat(20)}`,
    binding: { status: "bound", passkey: null },
    bind: { txHash: null },
    register: { ...initialRegisterState, registeredAt: 1_788_876_542_000, block: 103_059_393n, ...over },
    actions: { saveSealed: () => undefined, stateAgain: async () => undefined },
  } as unknown as Studio;
}

describe("the way out of the receipt", () => {
  it("offers the rest of the pictures once the registration is really on Monad", () => {
    const markup = render("en", createElement(Receipt, { studio: receipt() }));
    expect(markup).toContain(en.mine.receiptLink);
    expect(markup).toContain('href="/mine"');
  });

  it("offers it on a sealed registration too, where there is no picture to publish", () => {
    const sealed = receipt({
      prepared: {
        sealed: true,
        passport: { exactHash: `0x${"ab".repeat(32)}` },
        metadata: { cid: "meta", uri: "ipfs://metadata" },
        manifest: { embedded: true },
      },
    });
    const markup = render("en", createElement(Receipt, { studio: sealed }));
    expect(markup).toContain(en.studio.sealed.receipt.label);
    expect(markup).toContain(en.mine.receiptLink);
  });

  it("says nothing about it before anything has been written", () => {
    const empty = {
      authenticated: false,
      binding: { status: "reading", passkey: null },
      bind: { txHash: null },
      register: initialRegisterState,
      actions: {},
    } as unknown as Studio;
    expect(render("en", createElement(Receipt, { studio: empty }))).not.toContain(en.mine.receiptLink);
  });
});

describe("what a crawler is told about a personal page", () => {
  it("closes /mine in every language", () => {
    const only = robots().rules;
    const rule = Array.isArray(only) ? only[0] : only;
    expect(rule.disallow).toContain("/*/mine");
  });

  it("leaves it out of the sitemap", () => {
    expect(pagePaths()).not.toContain("/mine");
  });
});

describe("the words, in every language the site speaks", () => {
  const locales = readdirSync("messages")
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.replace(".json", ""));

  const files = new Map(
    locales.map((locale) => [locale, JSON.parse(read(`messages/${locale}.json`)) as Record<string, unknown>]),
  );

  function at(locale: string, path: string): unknown {
    return path
      .split(".")
      .reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], files.get(locale));
  }

  it("has all ten language files", () => {
    expect(locales).toHaveLength(10);
  });

  for (const key of MINE_KEYS) {
    it(`says ${key} in ten languages`, () => {
      const said = locales.filter((locale) => {
        const value = at(locale, key);
        return typeof value === "string" && value.trim().length > 0;
      });
      expect(said.length, `${key}: ${said.join(" ")}`).toBe(10);
    });
  }

  it("is written in each language's own words, not English ten times over", () => {
    for (const key of ["mine.entry", "mine.receiptLink", "mine.signedOut.heading", "studio.passports.heading"]) {
      const english = String(at("en", key));
      const copied = locales.filter((locale) => locale !== "en" && String(at(locale, key)) === english);
      expect(copied, `${key} left in English for: ${copied.join(" ")}`).toHaveLength(0);
    }
  });

  it("carries the long dash nobody here writes in no language at all", () => {
    const banned = String.fromCodePoint(0x2014);
    for (const locale of locales) {
      expect(JSON.stringify(at(locale, "mine")).includes(banned), locale).toBe(false);
    }
  });
});
