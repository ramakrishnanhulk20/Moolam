// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, Component, createElement, type FunctionComponent, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider, createTranslator } from "next-intl";
import type { Hex } from "viem";
import en from "@/messages/en.json";
import { timeFormats } from "@/lib/i18n/timeFormats";
import type { Art } from "@/components/passport/art";
import type { Passport } from "@/lib/chain/registry";
import type { PassportListing } from "@/lib/data/passports";
import type { CreatorPassports } from "@/lib/studio/useCreatorPassports";
import type { UnsealRecord } from "@/lib/verifier/client";

/**
 * The findings of the section 13 review of 2026-09-29, one describe per step of
 * work order 229. The review read the code and ran nothing, so each case here
 * was run against the code as it stood before its fix and failed there first.
 * The index, the gateway and the chain are stood in for; nothing here calls out.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const index = vi.hoisted(() => ({
  byCreator: [] as { wallet: string; limit: number; offset: number }[],
  rows: [] as PassportListing[],
  ask: undefined as unknown,
  art: {} as Record<string, Art>,
  chain: {} as Record<string, Passport | null>,
  docs: {} as Record<string, Art>,
  unseal: undefined as { state: "unsealed"; record: UnsealRecord } | undefined,
  scripts: [] as string[],
}));

vi.mock("next/cache", async (original) => ({
  ...(await original<typeof import("next/cache")>()),
  unstable_cache: <T>(read: T) => read,
}));

vi.mock("@/lib/data/passports", async (original) => ({
  ...(await original<typeof import("@/lib/data/passports")>()),
  passportsByCreator: async (wallet: Hex, limit: number, offset: number) => {
    index.byCreator.push({ wallet, limit, offset });
    return index.rows;
  },
  askIndex: async () => index.ask,
  heldArt: async (uri: string) => index.art[uri] ?? { missing: true },
}));

// The poster's trust mark reads the chain and the index; this file is about the record rules.
vi.mock("@/components/mark/read", async () => (await import("./mark-fixtures")).markReadMock);

vi.mock("@/lib/chain/registry", async (original) => ({
  ...(await original<typeof import("@/lib/chain/registry")>()),
  getPassport: async (id: Hex) => index.chain[id.toLowerCase()] ?? null,
}));

vi.mock("@/components/passport/art", async (original) => ({
  ...(await original<typeof import("@/components/passport/art")>()),
  readArt: async (uri: string) => index.docs[uri] ?? { missing: true },
}));

vi.mock("@/lib/verifier/client", async (original) => ({
  ...(await original<typeof import("@/lib/verifier/client")>()),
  readUnsealRecord: async () => index.unseal ?? { state: "sealed" },
}));

vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => createTranslator({ locale: "en", messages: en, namespace }),
  getFormatter: async () => ({
    dateTime: (date: Date) => new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" }).format(date),
  }),
  setRequestLocale: () => undefined,
}));

vi.mock("@/lib/i18n/routing", () => ({
  routing: { locales: ["en", "ta", "hi", "zh", "ja", "ko", "es", "fr", "de", "pt"], defaultLocale: "en" },
  Link: (props: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined, replace: () => undefined }),
  useParams: () => ({ locale: "en" }),
}));

vi.mock("@/components/passport/Picture", () => ({
  Picture: (props: { sources: string[] }) => createElement("span", { "data-picture": props.sources[0] }),
}));

vi.mock("@/lib/passport/refresh", () => ({ refreshPassport: async () => undefined }));
vi.mock("@/lib/chain/reports", () => ({ heldReportDelivery: async () => "simulation" }));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("next/script", () => ({
  default: (props: { id: string; dangerouslySetInnerHTML: { __html: string } }) => {
    index.scripts.push(props.dangerouslySetInnerHTML.__html);
    return createElement("template", { "data-script": props.id });
  },
}));
vi.mock("next/link", () => ({
  default: (props: { href: string; className?: string; children?: ReactNode }) =>
    createElement("a", { href: props.href, className: props.className }, props.children),
}));
vi.mock("@/lib/fonts", () => ({ fontVariables: "fonts" }));

const privy = vi.hoisted(() => ({
  session: { ready: true, authenticated: false } as Record<string, unknown>,
  wallets: [] as { walletClientType: string; address: string }[],
}));

vi.mock("@privy-io/react-auth", () => ({
  usePrivy: () => privy.session,
  useWallets: () => ({ wallets: privy.wallets }),
}));

const { awaitPassport } = await import("@/lib/data/passports");
const { useCreatorPassports } = await import("@/lib/studio/useCreatorPassports");

function render(node: ReactElement): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
    formats: unknown;
  }>;
  return renderToStaticMarkup(
    createElement(Provider, { locale: "en", messages: en, timeZone: "UTC", formats: timeFormats }, node),
  );
}

/** A passport id that starts and ends the way the board's short form names it. */
function idLike(head: string, tail: string): Hex {
  return `0x${head}${"0".repeat(64 - head.length - tail.length)}${tail}` as Hex;
}

function chainPassport(id: Hex, metadataURI: string): Passport {
  return {
    id,
    exactHash: id,
    parentId: `0x${"00".repeat(32)}` as Hex,
    creator: `0x${"85".repeat(20)}` as Hex,
    generatorAgentId: 10248n,
    phash: 0x6ccf137087789a25n,
    blockhash256: `0x${"11".repeat(32)}` as Hex,
    manifestHash: `0x${"00".repeat(32)}` as Hex,
    kind: 0,
    fingerprintVersion: 1,
    registeredAt: 1_788_881_666n,
    disputed: false,
    metadataURI,
  };
}

/** One passport under a generator, as the board's strip query returns it. */
function stripRow(id: Hex, metadataURI: string) {
  return {
    id,
    metadataURI,
    manifestHash: `0x${"0".repeat(64)}`,
    disputed: false,
    attestationCount: 0,
    attestations: [],
    parent: null,
  };
}

let root: Root | undefined;

afterEach(() => {
  if (root !== undefined) {
    const mounted = root;
    act(() => mounted.unmount());
    root = undefined;
  }
});

describe("step 2: my pictures never leaving reading", () => {
  const WALLET = `0x${"c3".repeat(20)}` as Hex;
  const CONFIRMED = `0x${"d4".repeat(32)}` as Hex;
  let seen: CreatorPassports;

  function Probe() {
    seen = useCreatorPassports(WALLET);
    return null;
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    index.byCreator = [];
    index.rows = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function wait(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it("says the pictures could not be read once the look window closes, and Try again opens a fresh one", async () => {
    awaitPassport(WALLET, CONFIRMED);
    const host = document.createElement("div");
    root = createRoot(host);
    act(() => root?.render(createElement(Probe)));
    await wait(0);

    // Monad confirmed a passport the index does not list yet: still reading.
    expect(seen.status).toBe("reading");
    await wait(30_000);
    expect(seen.status).toBe("reading");

    await wait(31_000);
    expect(seen.status).toBe("unreadable");
    expect(seen.error).toBeNull();
    const asked = index.byCreator.length;
    await wait(120_000);
    expect(index.byCreator.length).toBe(asked);
    expect(seen.status).toBe("unreadable");

    act(() => seen.refresh());
    await wait(0);
    expect(seen.status).toBe("reading");
    const afterPress = index.byCreator.length;
    await wait(20_000);
    expect(index.byCreator.length).toBeGreaterThan(afterPress);
    expect(seen.status).toBe("reading");
    await wait(45_000);
    expect(seen.status).toBe("unreadable");
  });
});

describe("step 3: one rule for the record was not read", () => {
  const NONE = idLike("a1", "01");
  const UNREAD = idLike("a2", "02");
  const NAMELESS = idLike("a3", "03");
  const NAMED = idLike("a4", "04");
  const inputs: { id: Hex; uri: string; art: Art | null }[] = [
    { id: NONE, uri: "", art: null },
    { id: UNREAD, uri: "ipfs://unread", art: { missing: true } },
    { id: NAMELESS, uri: "ipfs://nameless", art: { title: undefined, description: "A harbour", missing: true } },
    { id: NAMED, uri: "ipfs://named", art: { title: "Harbour at dusk", missing: true } },
  ];

  beforeEach(() => {
    index.art = {};
    index.chain = {};
    for (const one of inputs) {
      if (one.art !== null) {
        index.art[one.uri] = one.art;
        index.chain[one.id.toLowerCase()] = chainPassport(one.id, one.uri);
      }
    }
  });

  it("is one predicate that also takes null, and Explore no longer keeps its own", async () => {
    const { recordUnread } = await import("@/components/passport/unread");
    expect(inputs.map((one) => recordUnread(one.art))).toEqual([true, true, false, false]);
    expect(Object.keys(await import("@/components/explore/plates"))).not.toContain("recordUnread");
  });

  it("gives the same answer on Explore, the agents strip, the family and the poster", async () => {
    const { buildPlates } = await import("@/components/explore/plates");
    const plates = await buildPlates(
      inputs.map((one) => ({
        id: one.id,
        kind: 0,
        registeredAt: 1_788_881_666n,
        metadataURI: one.uri,
        manifest: false,
        rechecked: false,
        chainlink: false,
        inheritedDisputed: false,
        generatorId: null,
        consent: null,
      })) as never,
    );
    // A passport with no document address has nothing a gateway could still
    // hand over, so its plate is not waiting on one: untitled with no picture,
    // it is a test image (WO-293a row 13). Only a pinned record keeps the wait.
    expect(plates.map((plate) => plate.unread)).toEqual([false, true, false, false]);

    // Each passport alone under an agent that has signed only it: a record read
    // with no name is a test image, and so is one with no document at all. One
    // a gateway has not handed over yet proves nothing either way.
    index.ask = {
      Generator: inputs.map((one, at) => ({ id: String(at), passportCount: 1, passports: [stripRow(one.id, one.uri)] })),
    };
    const { boardStrips } = await import("@/components/agents/strip");
    const strips = await boardStrips();
    expect(inputs.map((_, at) => strips[String(at)].onlyTest)).toEqual([true, false, true, false]);

    const { familyOf } = await import("@/components/passport/family");
    const family = await familyOf(inputs.map((one) => one.id));
    expect(inputs.map((one) => family[one.id.toLowerCase()] === undefined)).toEqual([true, true, false, false]);

    const { Poster } = await import("@/components/passport/Poster");
    const posters: string[] = [];
    for (const one of inputs) {
      if (one.art !== null) {
        posters.push(render(await Poster({ passport: chainPassport(one.id, one.uri), art: one.art, locale: "en" })));
      }
    }
    expect(posters.map((markup) => markup.includes("data-title-unread"))).toEqual([true, false, false]);
  });
});

describe("step 4: the strip draws only pictures, and Load more says its failure in words", () => {
  it("gives no tile to agent 10248's two passports whose documents never load, nor to a read one with no picture", async () => {
    const first = idLike("9f0f2b", "2c35");
    const second = idLike("7b4732", "1a50");
    const nameOnly = idLike("5e", "77");
    const pictured = idLike("6c", "88");
    index.art = {
      "ipfs://never-a": { missing: true },
      "ipfs://never-b": { missing: true },
      "ipfs://name-only": { title: "Harbour at dusk", missing: true },
      "ipfs://pictured": { title: "Temple steps", thumbnailUrl: "https://gw/pictured", missing: false },
    };
    index.ask = {
      Generator: [
        {
          id: "10248",
          passportCount: 4,
          passports: [
            stripRow(first, "ipfs://never-a"),
            stripRow(second, "ipfs://never-b"),
            stripRow(nameOnly, "ipfs://name-only"),
            stripRow(pictured, "ipfs://pictured"),
          ],
        },
      ],
    };
    const { boardStrips } = await import("@/components/agents/strip");
    const strip = (await boardStrips())["10248"];
    expect(strip.tiles.map((tile) => tile.id)).toEqual([pictured]);
    expect(strip.tiles.every((tile) => tile.thumbnailUrl !== null)).toBe(true);
    expect(strip.onlyTest).toBe(false);
  });

  it("prints the translated sentence under Load more, with the cleaned reason only inside the folded Details", async () => {
    const { YourPassports } = await import("@/components/studio/YourPassports");
    const { WideLayout } = await import("@/components/studio/layout");
    const raw = "HTTP request failed.\nURL: https://indexer.example/secret-key/v1/graphql\nStatus: 429";
    const markup = render(
      createElement(WideLayout, null, createElement(YourPassports, {
        passports: {
          status: "ready",
          passports: [
            {
              id: idLike("6c", "88"),
              kind: 0,
              registeredAt: 1_788_881_666n,
              registeredBlock: 100n,
              metadataURI: "ipfs://pictured",
              title: "Temple steps",
            },
          ],
          error: null,
          refresh: () => undefined,
          hasMore: true,
          loadingMore: false,
          moreError: raw,
          more: () => undefined,
        } as CreatorPassports,
      })),
    );
    const alert = /<p role="alert"[^>]*>([\s\S]*?)<\/p>/.exec(markup)?.[1] ?? "";
    expect(alert).toContain(en.studio.passports.unreadable);
    expect(alert).not.toContain("HTTP request failed");
    const details = /<details data-failure-details[^>]*>([\s\S]*?)<\/details>/.exec(markup)?.[1] ?? "";
    expect(details).toContain("HTTP request failed.");
    expect(markup).not.toContain("secret-key");
    expect(markup).not.toContain("Status: 429");
  });
});

describe("step 5: the film never prints a distance nobody measured", () => {
  it("refuses a shown step with no measured distance, loads today's six, and never prints 64 for a missing one", async () => {
    const { bitsApart, degradeSteps } = await import("@/components/story/measurements");
    const degrade = (await import("@/public/hero/degrade.json")).default;

    const unmeasured = {
      ...degrade,
      shown: [...degrade.shown, "crop-10"],
    };
    expect(degrade.steps.find((step) => step.transform === "crop-10")?.phashDistance).toBeNull();
    expect(() => degradeSteps(unmeasured)).toThrow(/crop-10/);

    const steps = degradeSteps();
    expect(steps.map((step) => step.transform)).toEqual(degrade.shown);
    expect(steps).toHaveLength(6);
    for (const step of steps) {
      expect(bitsApart(step)).toBe(String(degrade.steps.find((entry) => entry.transform === step.transform)?.phashDistance));
    }

    expect(() => bitsApart({ phashDistance: null })).toThrow();
  });
});

describe("step 6: a Try again that worked is forgotten", () => {
  const broken = { now: true };

  function Flaky({ round }: { round: number }) {
    if (broken.now) {
      throw new Error(`the page broke on round ${round}`);
    }
    return createElement("p", { "data-page": round }, "the page");
  }

  async function mountBoundary() {
    const { default: LocaleError } = await import("@/app/[locale]/error");
    // A stand-in for Next's boundary: reset draws the page again, and a page
    // that throws puts the error page back in its place.
    class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
      state = { error: null as Error | null };
      static getDerivedStateFromError(error: Error) {
        return { error };
      }
      render() {
        return this.state.error === null
          ? this.props.children
          : createElement(LocaleError, { error: this.state.error, reset: () => this.setState({ error: null }) });
      }
    }
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const draw = (round: number) =>
      act(() =>
        root?.render(
          createElement(
            NextIntlClientProvider as unknown as FunctionComponent<{ locale: string; messages: unknown; children: ReactNode }>,
            { locale: "en", messages: en },
            createElement(Boundary, null, createElement(Flaky, { round })),
          ),
        ),
      );
    return { host, draw };
  }

  async function pressTryAgain(host: HTMLElement) {
    const button = host.querySelector("button");
    expect(button?.textContent).toBe(en.error.retry);
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // The page that went away is counted out on the next turn.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("says it stopped when the try fails again", async () => {
    window.history.pushState(null, "", "/en/fails-again");
    broken.now = true;
    const { host, draw } = await mountBoundary();
    draw(1);
    expect(host.querySelector("[data-tried-again]")).toBeNull();
    await pressTryAgain(host);
    expect(host.querySelector("[data-tried-again]")?.textContent).toBe(en.retry.stopped);
  });

  it("does not say it stopped when the try worked and the page later fails afresh", async () => {
    window.history.pushState(null, "", "/en/works-then-fails");
    broken.now = true;
    const { host, draw } = await mountBoundary();
    draw(1);
    expect(host.querySelector("[data-tried-again]")).toBeNull();
    broken.now = false;
    await pressTryAgain(host);
    expect(host.querySelector("[data-page]")).not.toBeNull();

    broken.now = true;
    draw(2);
    expect(host.querySelector("button")?.textContent).toBe(en.error.retry);
    expect(host.querySelector("[data-tried-again]")).toBeNull();
  });
});

describe("step 7: a stored picture address goes through the pinned rule everywhere", () => {
  const TRACKER = "https://tracker.example/x.png";
  const SEALED = idLike("5a", "1d");

  function file(uri: string) {
    return { cid: "bafkreipicture", uri, gatewayUrl: uri };
  }

  let calls: string[];

  beforeEach(() => {
    calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        calls.push(String(input));
        return {
          ok: true,
          json: async () => ({ name: "Night market", image: TRACKER, thumbnail: TRACKER }),
        };
      }),
    );
    index.chain = { [SEALED.toLowerCase()]: chainPassport(SEALED, "ipfs://bafkreisealeddoc") };
    index.docs = { "ipfs://bafkreisealeddoc": { title: "Night market", sealed: true, missing: false } };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    index.unseal = undefined;
  });

  it("gives an unseal record naming another host no thumbnail on the verify answer, and makes no request", async () => {
    index.unseal = {
      state: "unsealed",
      record: {
        passportId: SEALED,
        image: file(TRACKER),
        thumbnail: file(TRACKER),
        record: file("ipfs://bafkreirecord"),
        unsealedBy: `0x${"85".repeat(20)}`,
        unsealedAt: "2026-09-28T10:00:00.000Z",
      },
    };
    const { matchedPassport } = await import("@/components/verify/lookup");
    const matched = await matchedPassport(SEALED);
    expect(matched?.thumbnailUrl).toBeUndefined();
    expect(JSON.stringify(matched)).not.toContain("tracker.example");
    expect(calls).toEqual([]);

    // The same record naming the file on IPFS draws it through Moolam's gateway.
    index.unseal = {
      ...index.unseal,
      record: { ...index.unseal.record, image: file("ipfs://bafkreipicture"), thumbnail: file("ipfs://bafkreithumb") },
    };
    const pinned = await matchedPassport(SEALED);
    expect(pinned?.thumbnailUrl).toMatch(/^https:\/\/[^/]+\/ipfs\/bafkreithumb$/);
    expect(pinned?.sealed).toBe(false);
  });

  it("never fetches a document or draws a picture off IPFS on the account's own grid", async () => {
    const WALLET = `0x${"e5".repeat(20)}` as Hex;
    index.rows = [
      { id: idLike("e1", "01"), kind: 0, registeredAt: 2n, registeredBlock: 2n, metadataURI: "https://tracker.example/doc.json" },
      { id: idLike("e2", "02"), kind: 0, registeredAt: 1n, registeredBlock: 1n, metadataURI: "ipfs://bafkreidocument" },
    ];
    let seen: CreatorPassports | undefined;
    function Probe() {
      seen = useCreatorPassports(WALLET);
      return null;
    }
    const host = document.createElement("div");
    root = createRoot(host);
    act(() => root?.render(createElement(Probe)));
    for (let turn = 0; turn < 4; turn += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    expect(seen?.status).toBe("ready");
    expect(calls.some((url) => url.includes("tracker.example"))).toBe(false);
    expect(calls).toHaveLength(1);
    const read = seen?.passports.find((row) => row.metadataURI === "ipfs://bafkreidocument");
    expect(read?.title).toBe("Night market");
    expect(read?.imageUrl).toBeUndefined();
  });
});

describe("step 9: the language redirect", () => {
  const LOCALES = ["en", "ta", "hi", "zh", "ja", "ko", "es", "fr", "de", "pt"];
  const ORIGIN = "https://moolam.example";

  /** Runs the line against a stand-in page and says where it sent the reader, if anywhere. */
  function run(script: string, pathname: string, languages: string[], search = "", hash = "") {
    let went: string | null = null;
    new Function("location", "navigator", "document", script)(
      { pathname, search, hash, replace: (to: string) => (went = to) },
      { languages, language: languages[0] },
      { documentElement: { style: { visibility: "" } } },
    );
    return went as string | null;
  }

  function checkRules(script: string) {
    const cases: [string, string[], string, string][] = [
      ["/verify", ["ta-IN", "en"], "", ""],
      ["//evil.example/x", ["ta"], "", ""],
      ["/\\evil.example", ["de"], "", ""],
      ["/", ["fr-FR"], "", ""],
      ["/explore", ["it"], "?view=test&next=//evil.example", "#top"],
      ["/verify", ["ja"], "?to=https://evil.example", "#//evil.example"],
    ];
    for (const [pathname, languages, search, hash] of cases) {
      const went = run(script, pathname, languages, search, hash);
      expect(went, pathname).not.toBeNull();
      const target = went as string;
      expect(target.startsWith("/"), target).toBe(true);
      expect(target.startsWith("//"), target).toBe(false);
      const language = target.slice(1).split(/[/?#]/)[0];
      expect(LOCALES, target).toContain(language);
      expect(new URL(target, `${ORIGIN}${pathname.replace(/^\/+/, "/")}`).origin, target).toBe(ORIGIN);
    }
    expect(run(script, "/verify", ["ta-IN", "en"])).toBe("/ta/verify");
    expect(run(script, "/", ["fr-FR"])).toBe("/fr");
    expect(run(script, "/explore", ["it"], "?view=test", "#top")).toBe("/en/explore?view=test#top");

    for (const pathname of ["/en", "/en/verify", "/ta/nothing-here", "/_next/x", "/api/x"]) {
      expect(run(script, pathname, ["ta"]), pathname).toBeNull();
    }
  }

  it("lives in lib/i18n/redirect.ts, prefixes a carried language on the same origin, and never redirects a language path", async () => {
    const { languageRedirect } = await import("@/lib/i18n/redirect");
    const { readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    // Vitest runs from packages/web, and jsdom gives this file an http address, not a path.
    const carried = readdirSync(join(process.cwd(), "messages"))
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.replace(/\.json$/, ""));
    expect([...carried].sort()).toEqual([...LOCALES].sort());

    const script = languageRedirect(LOCALES, "en");
    checkRules(script);

    // The page draws the same line twice: the plain tag and the loader's copy.
    index.scripts = [];
    const { default: RootNotFound } = await import("@/app/not-found");
    const page = renderToStaticMarkup(createElement(RootNotFound));
    const tags = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
    expect(tags).toEqual([script]);
    expect(page).toContain('data-script="language-redirect"');
    expect(index.scripts).toEqual([script]);
  });
});

describe("step 10: receipts kept for the visit", () => {
  const PASSPORT = idLike("be", "ef");
  const HOLDER = `0x${"a7".repeat(20)}` as Hex;
  const STRANGER = `0x${"b8".repeat(20)}` as Hex;

  function pinned(cid: string) {
    return { cid, uri: `ipfs://${cid}`, gatewayUrl: `https://gw.example/ipfs/${cid}` };
  }

  it("draws the unseal receipt for the holder only: not after a sign out, not for another account", async () => {
    const { keepReceipt, keptReceipt } = await import("@/components/passport/UnsealPanel");
    const { Unsealer } = await import("@/components/passport/Unsealer");
    keepReceipt(PASSPORT, {
      passportId: PASSPORT,
      image: pinned("bafkreiimage"),
      thumbnail: pinned("bafkreithumb"),
      record: pinned("bafkreirecord"),
      unsealedBy: HOLDER,
      unsealedAt: "2026-09-28T10:00:00.000Z",
    });
    const receipt = keptReceipt(PASSPORT);
    expect(receipt).toBeDefined();

    const drawn = (session: { authenticated: boolean }, wallet: Hex | null) => {
      privy.session = { ready: true, login: () => undefined, getAccessToken: async () => null, ...session };
      privy.wallets = wallet === null ? [] : [{ walletClientType: "privy", address: wallet }];
      const markup = render(
        createElement(Unsealer, {
          passportId: PASSPORT,
          owner: HOLDER,
          visit: { receipt, settled: true, keep: () => undefined, firstReveal: () => false },
        }),
      );
      return markup.includes("data-unseal-receipt");
    };

    expect(drawn({ authenticated: true }, HOLDER)).toBe(true);
    expect(drawn({ authenticated: false }, null)).toBe(false);
    expect(drawn({ authenticated: false }, HOLDER)).toBe(false);
    expect(drawn({ authenticated: true }, STRANGER)).toBe(false);
  });

  it("keeps only the challenge's transaction hash and block, which the chain already shows to anyone", async () => {
    const { keepChallenge, keptChallenge, KeptReceipt } = await import("@/components/passport/Challenge");
    const hash = `0x${"c9".repeat(32)}` as Hex;
    keepChallenge(PASSPORT, { hash, block: 108_487_207n });
    const kept = keptChallenge(PASSPORT);
    expect(kept).toEqual({ hash, block: 108_487_207n });
    expect(Object.keys(kept ?? {}).sort()).toEqual(["block", "hash"]);

    const markup = render(createElement(KeptReceipt, { receipt: kept as NonNullable<typeof kept> }));
    expect(markup).toContain(`/tx/${hash}`);
  });
});
