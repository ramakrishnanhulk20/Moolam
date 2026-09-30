import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider, createTranslator } from "next-intl";
import type { Hex } from "viem";
import en from "@/messages/en.json";
import type { Art } from "@/components/passport/art";
import type { JumpHistory, JumpTarget } from "@/components/passport/top-facts";
import type { Passport } from "@/lib/chain/registry";
import { initialUnsealState, type PassportUnseal, type UnsealState } from "@/lib/passport/unseal";

/**
 * The passport polish: a grid whose light sweep can no longer widen the page on
 * a phone, facts links that jump without a history entry the router never
 * wrote, an id that reads as hex, a download pad nothing clips, and a Published
 * receipt that outlives the refresh which turns the page public.
 */

vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => createTranslator({ locale: "en", messages: en, namespace }),
  getFormatter: async () => ({
    dateTime: (date: Date) => new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" }).format(date),
  }),
  setRequestLocale: () => undefined,
}));

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

vi.mock("@/components/passport/Picture", () => ({
  Picture: () => createElement("span", { "data-picture": "true" }),
}));

const stub = vi.hoisted(() => ({ current: null as unknown as PassportUnseal }));

vi.mock("@/lib/passport/unseal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/passport/unseal")>()),
  useUnsealPassport: () => stub.current,
}));

vi.mock("@/lib/passport/refresh", () => ({ refreshPassport: async () => undefined }));

const chunks = vi.hoisted(() => ({ pending: [] as Promise<unknown>[] }));

vi.mock("next/dynamic", () => ({
  default: (load: () => Promise<FunctionComponent<never>>) => {
    let Loaded: FunctionComponent<never> | null = null;
    chunks.pending.push(
      load().then((component) => {
        Loaded = component;
      }),
    );
    return (props: never) => (Loaded === null ? null : createElement(Loaded, props));
  },
}));

const { BitGrid } = await import("@/components/BitGrid");
const { FactStrip } = await import("@/components/passport/TopFacts");
const { FactJumpLink, isPlainClick } = await import("@/components/passport/FactJump");
const { topFacts, jumpToFact, FACT_ANCHORS } = await import("@/components/passport/top-facts");
const { Poster } = await import("@/components/passport/Poster");
const { WalletMounted } = await import("@/components/providers/WalletProvider");
const { UnsealPanel, keepReceipt, keptReceipt, firstReveal, showsUnsealPanel } = await import(
  "@/components/passport/UnsealPanel"
);
const { editPictureAlt } = await import("@/components/passport/Editor");
const { shortHex } = await import("@/lib/chain/client");

await Promise.all(chunks.pending);

const ID = `0x${"7c".repeat(32)}` as Hex;
const OTHER = `0x${"3d".repeat(32)}` as Hex;
const HOLDER = "0x551610a063BcAd79e6bd25dc55cEe92Ba3FD960a" as Hex;

function render(node: ReactElement): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;
  const mounted = createElement(WalletMounted.Provider, { value: true }, node);
  return renderToStaticMarkup(createElement(Provider, { locale: "en", messages: en, timeZone: "UTC" }, mounted));
}

/** The class list of the first element carrying this attribute. */
function classOf(markup: string, attribute: string): string {
  const match = new RegExp(`<[a-z]+[^>]*${attribute}[^>]*class="([^"]*)"|<[a-z]+[^>]*class="([^"]*)"[^>]*${attribute}`).exec(markup);
  expect(match, attribute).not.toBeNull();
  return (match?.[1] ?? match?.[2]) as string;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the fingerprint grid on a phone", () => {
  it("draws its light sweep inside a box that clips, so the parked sweep cannot widen the page", () => {
    const bits = Array.from({ length: 64 }, (_, at) => at % 3 === 0);
    const markup = render(createElement(BitGrid, { bits, label: "Original", tone: "original" }));

    expect(classOf(markup, "data-bit-clip").split(/\s+/)).toContain("overflow-hidden");
    const clip = markup.indexOf("data-bit-clip");
    const sweep = markup.indexOf("bg-gradient-to-r");
    expect(sweep).toBeGreaterThan(clip);
    // The clip box is the figure's last child, so anything before the figure
    // closes and after the box opens is inside it.
    expect(sweep).toBeLessThan(markup.indexOf("</figure>"));
    // The cells sit in the same box, untouched by it.
    expect(markup.indexOf("grid-cols-8")).toBeGreaterThan(clip);
  });
});

describe("a facts link to a section lower on the page", () => {
  const say = {
    kind: (kind: number) => en.kind[String(kind) as "0" | "1" | "2"],
    agentNumber: (id: string) => `Agent ${id}`,
    cardNamed: (agent: string) => en.passport.facts.cardNamed.replace("{agent}", agent),
    statement: (statement: string) => en.passport.consent.summary[statement as "closed"],
    bits: (count: number) => `${count} of 64 bits`,
    privateRecheck: en.passport.attestations.private.badge,
    sealed: en.passport.sealed.label,
    date: () => "Sep 27, 2026",
    words: en.passport.facts,
  };
  const input = {
    creator: HOLDER,
    agentId: 10249n,
    agentName: "Moolam generator",
    kind: 0,
    consent: null,
    attestations: [],
    phash: 1n,
    sealed: false,
    privateRecheck: false,
  };

  function stubs() {
    const target = {
      scrollIntoView: vi.fn<JumpTarget["scrollIntoView"]>(),
      focus: vi.fn<JumpTarget["focus"]>(),
      hasAttribute: vi.fn(() => false),
      setAttribute: vi.fn<JumpTarget["setAttribute"]>(),
    };
    const routerState = { __NA: true, tree: ["passport"] };
    const history = {
      state: routerState,
      replaceState: vi.fn<JumpHistory["replaceState"]>(),
      pushState: vi.fn(),
    };
    return { target, history, routerState };
  }

  const click = (over: Partial<Parameters<typeof isPlainClick>[0]> = {}) => ({
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    preventDefault: vi.fn(),
    ...over,
  });

  it("keeps a real hash href, so it works with no script and on a middle click", () => {
    const markup = render(FactStrip({ facts: topFacts(input, say) }));
    expect(markup).toContain(`href="#${FACT_ANCHORS.madeBy}"`);
    expect(markup).toContain(`href="#${FACT_ANCHORS.aiUse}"`);
    expect(markup).toContain(`href="#${FACT_ANCHORS.rechecked}"`);
  });

  it("swaps the address in place with the router's own state, and never pushes an entry", () => {
    const { target, history, routerState } = stubs();
    jumpToFact(FACT_ANCHORS.madeBy, { target, history, reduced: false });

    expect(history.replaceState).toHaveBeenCalledWith(routerState, "", `#${FACT_ANCHORS.madeBy}`);
    expect(history.pushState).not.toHaveBeenCalled();
    expect(target.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    expect(target.setAttribute).toHaveBeenCalledWith("tabindex", "-1");
    expect(target.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("jumps at once for a reader who asked for less motion", () => {
    const { target, history } = stubs();
    jumpToFact(FACT_ANCHORS.aiUse, { target, history, reduced: true });
    expect(target.scrollIntoView).toHaveBeenCalledWith({ behavior: "instant", block: "start" });
  });

  it("takes over a plain click through the link itself", () => {
    const { target, history } = stubs();
    vi.stubGlobal("document", { getElementById: (id: string) => (id === FACT_ANCHORS.madeBy ? target : null) });
    vi.stubGlobal("window", {
      history,
      location: { pathname: "/en/passport/0x1", search: "" },
      matchMedia: () => ({ matches: false }),
    });

    const link = FactJumpLink({ href: `#${FACT_ANCHORS.madeBy}`, children: "Made by" });
    const event = click();
    (link.props as { onClick: (event: unknown) => void }).onClick(event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(history.replaceState).toHaveBeenCalledTimes(1);
    // The entry keeps the page's own address: a fragment there sent Back to the section.
    expect(history.replaceState).toHaveBeenCalledWith(history.state, "", "/en/passport/0x1");
    expect(history.pushState).not.toHaveBeenCalled();
    expect(target.focus).toHaveBeenCalled();
  });

  it("leaves a middle click, a modified click, or a missing section to the browser", () => {
    const { target, history } = stubs();
    vi.stubGlobal("document", { getElementById: () => null });
    vi.stubGlobal("window", { history, matchMedia: () => ({ matches: false }) });

    const onClick = (FactJumpLink({ href: "#nowhere", children: "x" }).props as { onClick: (event: unknown) => void })
      .onClick;
    for (const event of [click({ button: 1 }), click({ metaKey: true }), click({ ctrlKey: true }), click()]) {
      onClick(event);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    expect(history.replaceState).not.toHaveBeenCalled();
    expect(target.scrollIntoView).not.toHaveBeenCalled();
    expect(isPlainClick(click())).toBe(true);
    expect(isPlainClick(click({ shiftKey: true }))).toBe(false);
    expect(isPlainClick(click({ defaultPrevented: true }))).toBe(false);
  });
});

describe("the poster's kicker and credit line", () => {
  const passport: Passport = {
    id: ID,
    exactHash: ID,
    parentId: `0x${"00".repeat(32)}` as Hex,
    creator: HOLDER,
    generatorAgentId: 10249n,
    phash: 1n,
    blockhash256: `0x${"11".repeat(32)}` as Hex,
    manifestHash: `0x${"22".repeat(32)}` as Hex,
    kind: 0,
    fingerprintVersion: 1,
    registeredAt: 1_788_881_666n,
    disputed: false,
    metadataURI: "ipfs://bafkreimetadata",
  };
  const art: Art = { title: "Kites at dusk", imageUrl: "https://gateway.example/ipfs/full", missing: false, original: true };

  it("sets the hex id in lower case inside the upper case label", async () => {
    const markup = render(await Poster({ passport, art, locale: "en" }));
    const id = /<span data-poster-id="true" class="([^"]*)">([^<]*)<\/span>/.exec(markup);
    expect(id?.[1].split(/\s+/)).toContain("normal-case");
    expect(id?.[2]).toBe(shortHex(ID, 10, 8));
  });

  it("gives the Download link's tap pad and focus ring room inside the clipping box", async () => {
    const markup = render(await Poster({ passport, art, locale: "en" }));
    const rem = (value: string | undefined): number => Number(value) * 4;

    const box = classOf(markup, "data-meta-line").split(/\s+/);
    expect(box).toContain("overflow-hidden");
    const room = rem(box.find((name) => /^py-/.test(name))?.slice(3));
    expect(box).toContain(`-my-${room / 4}`);

    const link = classOf(markup, "data-download-original").split(/\s+/);
    const pad = rem(link.find((name) => /^py-/.test(name))?.slice(3));
    expect(link).toContain(`-my-${pad / 4}`);
    // The pad plus a 16 px line clears the 44 px tap floor, and the ring, a
    // 2 px outline 2 px out, still fits inside the room the box keeps.
    expect(pad * 2 + 16).toBeGreaterThanOrEqual(44);
    expect(room).toBeGreaterThanOrEqual(pad + 4);
  });
});

describe("the Published receipt after the page turns public", () => {
  const RESULT = {
    passportId: ID,
    image: { cid: "bafkreiimage", uri: "ipfs://bafkreiimage", gatewayUrl: "https://service.example/ipfs/bafkreiimage" },
    thumbnail: { cid: "bafkreithumb", uri: "ipfs://bafkreithumb", gatewayUrl: "https://service.example/ipfs/bafkreithumb" },
    record: { cid: "bafkreirecord", uri: "ipfs://bafkreirecord", gatewayUrl: "https://service.example/ipfs/bafkreirecord" },
    unsealedBy: HOLDER,
    unsealedAt: "2026-09-22T06:12:44.000Z",
  };

  function unseal(state: Partial<UnsealState> = {}): PassportUnseal {
    return {
      ready: true,
      isHolder: true,
      state: { ...initialUnsealState, ...state },
      actions: { choose: async () => undefined, publish: async () => undefined, signIn: () => undefined, reset: () => undefined },
    };
  }

  function panel(passportId: Hex, sealed: boolean): string {
    return render(createElement(UnsealPanel, { passportId, owner: HOLDER, sealed }));
  }

  it("says nothing on a public passport that nobody published during this visit", () => {
    stub.current = unseal();
    expect(showsUnsealPanel(false, undefined)).toBe(false);
    expect(panel(OTHER, false)).toBe("");
  });

  it("stays on screen, with its addresses, once the refresh has made the passport public", () => {
    stub.current = unseal({ result: RESULT });
    const before = panel(ID, true);
    expect(before).toContain(en.passport.unseal.done.label);

    // What the panel's effect does the moment Publish answers.
    keepReceipt(ID, RESULT);

    // The refresh lands: the page is public now and the panel's own state is
    // gone, as it is when the panel is drawn again.
    stub.current = unseal();
    const after = panel(ID, false);
    expect(after).toContain("data-unseal-receipt");
    expect(after).toContain(en.passport.unseal.done.label);
    expect(after).toContain("bafkreiimage");
    expect(after).toContain("bafkreirecord");
    expect(after).not.toContain(en.passport.unseal.publish);
  });

  it("keys the receipt to its own passport, in any letter case", () => {
    keepReceipt(ID, RESULT);
    expect(keptReceipt(ID.toUpperCase().replace("0X", "0x") as Hex)).toBe(RESULT);
    expect(keptReceipt(OTHER)).toBeUndefined();
    stub.current = unseal();
    expect(panel(OTHER, false)).toBe("");
  });

  it("brings the receipt into view once, and never again on a later visit to the page", () => {
    const fresh = `0x${"ab".repeat(32)}` as Hex;
    expect(firstReveal(fresh)).toBe(true);
    expect(firstReveal(fresh)).toBe(false);
  });
});

describe("the edit panel's pictures", () => {
  it("names each picture by its title, falling back while no title is typed", () => {
    expect(editPictureAlt("  Kites at dusk ", "kites.jpg")).toBe("Kites at dusk");
    expect(editPictureAlt("   ", "kites.jpg")).toBe("kites.jpg");
  });
});
