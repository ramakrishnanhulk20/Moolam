// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { act, createElement, type FunctionComponent, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import en from "@/messages/en.json";

/**
 * WO-260: the co-sign and connect pages as a checkout window. The window is
 * found from two facts together, an opener and a small viewport; the compact
 * layout offers the same presses behind the same P1 gate as the full page;
 * the window shuts only after its message went out and only when a script
 * opened it; and the full page at 1440 is the markup it was before this order.
 */

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
}));
vi.mock("@/components/passport/Picture", () => ({
  Picture: () => createElement("span", { "data-picture": true }),
}));

const flow = await import("@/lib/cosign/flow");
const popup = await import("@/lib/cosign/popup");
const { CosignSheet } = await import("@/components/cosign/CosignSheet");
const { ConnectPanel } = await import("@/components/connect/ConnectPanel");
type CosignModel = import("@/lib/cosign/flow").CosignModel;
type CosignAction = import("@/lib/cosign/flow").CosignAction;
type AgentFacts = import("@/lib/cosign/listing").AgentFacts;
type CosignRecord = import("@/lib/cosign/record").CosignRecord;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const EXACT = `0x${"7a".repeat(32)}` as Hex;
const WALLET = "0xc3714B31A5F300D7A79f72C7AEC61240D2f384E7" as Hex;
const TX = `0x${"5e".repeat(32)}` as Hex;
const RECORD: CosignRecord = {
  state: "signed",
  agentId: "4242",
  platform: { name: "Acme Studio", agentId: "4242" },
  exactHash: EXACT,
  passport: {
    exactHash: EXACT,
    parentId: `0x${"00".repeat(32)}` as Hex,
    creator: WALLET,
    generatorAgentId: "4242",
    phash: "1",
    blockhash256: `0x${"ab".repeat(32)}` as Hex,
    manifestHash: `0x${"cd".repeat(32)}` as Hex,
    kind: 0,
    fingerprintVersion: 1,
    metadataURI: "ipfs://bafkreimetadata000000000000000",
    deadline: "1790001800",
  },
  files: {
    image: { cid: "i", uri: "ipfs://i", gatewayUrl: "https://g.example/ipfs/i", bytes: 10 },
    thumbnail: { cid: "t", uri: "ipfs://t", gatewayUrl: "https://g.example/ipfs/t", bytes: 10 },
    manifest: { cid: "m", uri: "ipfs://m", gatewayUrl: "https://g.example/ipfs/m", bytes: 10 },
    metadata: { cid: "d", uri: "ipfs://d", gatewayUrl: "https://g.example/ipfs/d", bytes: 10 },
  },
  openBy: 1_790_000_000,
  digest: `0x${"01".repeat(32)}` as Hex,
  agentSignature: `0x${"11".repeat(65)}` as Hex,
};
const LISTED: AgentFacts = {
  agentId: "4242",
  name: "Totally Real Corp",
  owner: WALLET,
  listing: { name: "Acme Studio", origins: ["https://acme.example"], badge: true },
  field: [],
};
const WITHHELD: AgentFacts = { ...LISTED, listing: { name: "Acme Studio", origins: ["https://acme.example"], badge: false } };
const PASSED = { type: "gate", gate: { at: "passed", digest: RECORD.digest } } as const;
const LANDED = { type: "send", send: { at: "registered", passportId: EXACT, txHash: TX } } as const;

function model(actions: CosignAction[], binding: "bound" | "unbound" = "bound"): CosignModel {
  let at = flow.initialCosign;
  for (const action of [
    { type: "handle", valid: true },
    { type: "auth", signedIn: true },
    { type: "answer", outcome: { kind: "record", record: RECORD } },
    { type: "binding", status: binding },
    ...actions,
  ] as CosignAction[]) {
    at = flow.cosignReducer(at, action);
  }
  return at;
}

const signedOut = flow.cosignReducer(flow.cosignReducer(flow.initialCosign, { type: "handle", valid: true }), { type: "auth", signedIn: false });

const Provider = NextIntlClientProvider as unknown as FunctionComponent<{ locale: string; messages: unknown; timeZone: string; children?: unknown }>;

function markup(element: ReactElement): string {
  return renderToStaticMarkup(createElement(Provider, { locale: "en", messages: en, timeZone: "UTC" }, element))
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, "\"");
}

function sheet(state: CosignModel, agent: AgentFacts | null, checkout?: boolean, onPress: (press: import("@/lib/cosign/flow").Press) => void = () => undefined): ReactElement {
  return createElement(CosignSheet, { model: state, agent, wallet: WALLET, onPress, checkout });
}

function panel(asker: { origin: string | null; name: string | null }, signedIn: boolean | null, checkout?: boolean): ReactElement {
  return createElement(ConnectPanel, { asker, wallet: signedIn ? WALLET : null, signedIn, onSignIn: () => undefined, checkout });
}

/** Every press a layout offers, with whether it can be pressed: the opening tag's data-press and disabled, nothing else. */
function presses(html: string): string[] {
  return [...html.matchAll(/<button[^>]*data-press="([^"]+)"[^>]*>/g)].map((match) => `${match[1]}${match[0].includes('disabled=""') ? ":off" : ":on"}`);
}

describe("the window is a checkout only with an opener and a small viewport, both", () => {
  it("needs both facts, and a phone that opened the page as a tab counts", () => {
    expect(popup.inCheckoutWindow({ hasOpener: true, width: 480 })).toBe(true);
    expect(popup.inCheckoutWindow({ hasOpener: true, width: 560 })).toBe(true);
    expect(popup.inCheckoutWindow({ hasOpener: true, width: 375 })).toBe(true);
    expect(popup.inCheckoutWindow({ hasOpener: true, width: 561 })).toBe(false);
    expect(popup.inCheckoutWindow({ hasOpener: true, width: 1440 })).toBe(false);
    expect(popup.inCheckoutWindow({ hasOpener: false, width: 480 })).toBe(false);
    expect(popup.inCheckoutWindow({ hasOpener: false, width: 375 })).toBe(false);
    expect(popup.inCheckoutWindow({ hasOpener: true, width: 0 })).toBe(false);
  });

  it("draws the full page on the server, whatever the window turns out to be", () => {
    const html = markup(sheet(model([PASSED]), LISTED));
    expect(html).not.toContain("data-checkout");
    expect(markup(panel({ origin: "https://acme.example", name: "Acme Studio" }, true))).not.toContain("data-checkout");
  });
});

describe("the compact co-sign keeps the full page's button and its P1 gate", () => {
  const cases: [string, CosignModel][] = [
    ["gate passed", model([PASSED])],
    ["gate checking", model([{ type: "gate", gate: { at: "checking" } }])],
    ["gate failed on the record", model([{ type: "gate", gate: { at: "failed", what: "record" } }])],
    ["gate failed on the picture", model([{ type: "gate", gate: { at: "failed", what: "picture" } }])],
    ["no passkey yet", model([], "unbound")],
    ["signing", model([PASSED, { type: "send", send: { at: "signing" } }])],
    ["signed out", signedOut],
    ["registered", model([PASSED, LANDED])],
  ];

  it.each(cases)("offers the same presses, open or shut alike: %s", (_, state) => {
    expect(presses(markup(sheet(state, LISTED, true)))).toEqual(presses(markup(sheet(state, LISTED))));
  });

  it("opens the passkey only on a passed gate, in one full-width button", () => {
    const open = markup(sheet(model([PASSED]), LISTED, true));
    expect(presses(open)).toEqual(["sign:on"]);
    expect(/<button[^>]*data-press="sign"[^>]*>/.exec(open)?.[0]).toContain("w-full");
    expect(presses(markup(sheet(model([{ type: "gate", gate: { at: "checking" } }]), LISTED, true)))).toEqual(["sign:off"]);
    expect(presses(markup(sheet(model([{ type: "gate", gate: { at: "failed", what: "record" } }]), LISTED, true)))).toEqual([]);
  });

  it("the same press reaches the page's handler from either layout", async () => {
    for (const checkout of [false, true]) {
      const pressed: string[] = [];
      const host = await mount(sheet(model([PASSED]), LISTED, checkout, (press: string) => void pressed.push(press)));
      act(() => host.querySelector<HTMLButtonElement>('[data-press="sign"]')?.click());
      expect(pressed, `checkout ${checkout}`).toEqual(["sign"]);
    }
  });

  it("folds the clauses to three lines and keeps all six, word for word, behind the toggle", () => {
    const html = markup(sheet(model([PASSED]), LISTED, true));
    expect([...html.matchAll(/data-fold-line="(\w+)"/g)].map((match) => match[1])).toEqual(["agent", "creator", "terms"]);
    expect([...html.matchAll(/data-clause="(\w+)"/g)].map((match) => match[1])).toEqual(["picture", "agent", "platform", "terms", "creator", "until"]);
    expect(html).toContain(`aria-expanded="false"`);
    expect(html).toContain(en.checkout.more);
    expect(html).toContain(en.cosign.agent.unchecked);
    expect(html).toContain(en.cosign.platform.listedLine.replace("{agent}", "4242"));
  });

  it("names a listed platform in the lock line, and no name when the badge is withheld or there is no listing", () => {
    expect(markup(sheet(model([PASSED]), LISTED, true))).toContain("Sent by Acme Studio, listed by Moolam");
    const withheld = markup(sheet(model([PASSED]), WITHHELD, true));
    expect(withheld).toContain(en.checkout.lockUnnamed);
    expect(withheld).not.toContain("For Acme Studio");
    expect(markup(sheet(model([PASSED]), { ...LISTED, listing: null }, true))).toContain(en.checkout.lockUnnamed);
  });

  it("presses the seal onto the thumbnail on registered, and only then", () => {
    expect(markup(sheet(model([PASSED]), LISTED, true))).not.toContain("data-seal-stamp");
    const landed = markup(sheet(model([PASSED, LANDED]), LISTED, true));
    expect(landed).toContain("data-seal-stamp");
    expect(landed).toContain(`/tx/${TX}`);
  });
});

describe("a finished window shuts only after its message went out, and only if a script opened it", () => {
  function clock() {
    let now = 0;
    const queue: { at: number; run: () => void; id: number }[] = [];
    let next = 0;
    const timers = {
      set: (run: () => void, ms: number) => {
        next += 1;
        queue.push({ at: now + ms, run, id: next });
        return next;
      },
      clear: (id: unknown) => {
        const index = queue.findIndex((entry) => entry.id === id);
        if (index >= 0) queue.splice(index, 1);
      },
    };
    // Time walks from one due timer to the next, so a timer set by another runs at its own moment.
    const advance = (ms: number) => {
      const until = now + ms;
      for (;;) {
        queue.sort((a, b) => a.at - b.at);
        const due = queue[0];
        if (due === undefined || due.at > until) break;
        queue.shift();
        now = due.at;
        due.run();
      }
      now = until;
    };
    return { timers, advance };
  }

  const scripted = () => ({ opener: {}, closed: false, close: vi.fn() });

  it("closes a script-opened window about 1.5 s after the message, not before", () => {
    const { timers, advance } = clock();
    const win = scripted();
    popup.closeWhenDone(win, true, () => undefined, timers);
    advance(popup.CLOSE_AFTER_MS - 1);
    expect(win.close).not.toHaveBeenCalled();
    advance(1);
    expect(win.close).toHaveBeenCalledTimes(1);
  });

  it("never closes before the message went out, nor a window the person opened", () => {
    const { timers, advance } = clock();
    const early = scripted();
    popup.closeWhenDone(early, false, () => undefined, timers);
    const byHand = { opener: null, closed: false, close: vi.fn() };
    popup.closeWhenDone(byHand, true, () => undefined, timers);
    advance(10_000);
    expect(early.close).not.toHaveBeenCalled();
    expect(byHand.close).not.toHaveBeenCalled();
    expect(popup.openedByScript(byHand)).toBe(false);
    const self = { opener: null as unknown, closed: false, close: vi.fn() };
    self.opener = self;
    expect(popup.openedByScript(self)).toBe(false);
  });

  it("offers the close when the browser kept the window open, and stays quiet when it shut", () => {
    const { timers, advance } = clock();
    const kept = scripted();
    const stuck = vi.fn();
    popup.closeWhenDone(kept, true, stuck, timers);
    advance(popup.CLOSE_AFTER_MS + popup.STUCK_AFTER_MS);
    expect(stuck).toHaveBeenCalledTimes(1);

    const shut = scripted();
    shut.close.mockImplementation(() => {
      shut.closed = true;
    });
    const quiet = vi.fn();
    popup.closeWhenDone(shut, true, quiet, timers);
    advance(popup.CLOSE_AFTER_MS + popup.STUCK_AFTER_MS);
    expect(quiet).not.toHaveBeenCalled();
  });

  it("cancels a pending close when the page leaves first", () => {
    const { timers, advance } = clock();
    const win = scripted();
    popup.closeWhenDone(win, true, () => undefined, timers)();
    advance(10_000);
    expect(win.close).not.toHaveBeenCalled();
  });

  it("calls a co-sign finished only once reported, registered, and the terms settled", () => {
    const landed = model([PASSED, LANDED]);
    expect(popup.cosignFinished(landed, false)).toBe(false);
    expect(popup.cosignFinished(landed, true)).toBe(true);
    expect(popup.cosignFinished(model([PASSED]), true)).toBe(false);
    for (const terms of [{ at: "waiting" }, { at: "sending" }, { at: "offered" }, { at: "failed", failure: { key: "reverted" } }] as const) {
      expect(popup.cosignFinished(flow.cosignReducer(landed, { type: "terms", terms }), true), terms.at).toBe(false);
    }
    expect(popup.cosignFinished(flow.cosignReducer(landed, { type: "terms", terms: { at: "written", txHash: TX } }), true)).toBe(true);
    expect(popup.cosignFinished(flow.cosignReducer(landed, { type: "terms", terms: { at: "stated", writer: WALLET } }), true)).toBe(true);
  });
});

const roots: Root[] = [];
let posts: [unknown, string][] = [];
let order: string[] = [];

beforeEach(() => {
  posts = [];
  order = [];
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
  );
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Object.defineProperty(window, "opener", { value: null, configurable: true, writable: true });
});

function withOpener(): void {
  Object.defineProperty(window, "opener", {
    value: {
      postMessage: (message: unknown, origin: string) => {
        posts.push([message, origin]);
        order.push("post");
      },
    },
    configurable: true,
    writable: true,
  });
}

function watchClose() {
  return vi.spyOn(window, "close").mockImplementation(() => void order.push("close"));
}

async function wait(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function mount(element: ReactElement): Promise<HTMLDivElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(createElement(Provider, { locale: "en", messages: en, timeZone: "UTC" }, element)));
  await wait(50);
  return host;
}

describe("the close, on the pages themselves", () => {
  it("co-sign: a registered window waits for the report, then shuts, then offers its own close button", async () => {
    withOpener();
    const close = watchClose();
    const landed = model([PASSED, LANDED]);
    const element = (reported: boolean) =>
      createElement(CosignSheet, { model: landed, agent: LISTED, wallet: WALLET, onPress: () => undefined, checkout: true, reported });

    const host = await mount(element(false));
    await wait(popup.CLOSE_AFTER_MS + 200);
    expect(close).not.toHaveBeenCalled();
    expect(host.querySelector("[data-closing]")).toBeNull();

    await act(async () => roots[0].render(createElement(Provider, { locale: "en", messages: en, timeZone: "UTC" }, element(true))));
    await wait(100);
    expect(host.textContent).toContain("Done. Taking you back to Acme Studio.");
    expect(close).not.toHaveBeenCalled();
    await wait(popup.CLOSE_AFTER_MS + popup.STUCK_AFTER_MS + 200);
    expect(close).toHaveBeenCalledTimes(1);
    // jsdom keeps the window open, as a browser does for a tab it will not close.
    expect(host.querySelector("[data-closing]")?.getAttribute("data-closing")).toBe("stuck");
    expect(host.querySelector("[data-close-window]")?.textContent).toBe(en.checkout.close);
    expect(host.textContent).toContain("Done. Taking you back to Acme Studio.");
  }, 15_000);

  it("co-sign: an unlisted platform gets the plain done line", async () => {
    withOpener();
    watchClose();
    const host = await mount(
      createElement(CosignSheet, { model: model([PASSED, LANDED]), agent: { ...LISTED, listing: null }, wallet: WALLET, onPress: () => undefined, checkout: true, reported: true }),
    );
    expect(host.textContent).toContain(en.checkout.doneUnlisted);
  });

  it("co-sign: the full page never shuts itself", async () => {
    withOpener();
    const close = watchClose();
    await mount(createElement(CosignSheet, { model: model([PASSED, LANDED]), agent: LISTED, wallet: WALLET, onPress: () => undefined, checkout: false, reported: true }));
    await wait(popup.CLOSE_AFTER_MS + 300);
    expect(close).not.toHaveBeenCalled();
  }, 10_000);

  it("connect: Share posts to the asking origin first and shuts the window after", async () => {
    withOpener();
    watchClose();
    const host = await mount(panel({ origin: "https://acme.example", name: "Acme Studio" }, true, true));
    await wait(100);
    expect(order).toEqual([]);
    act(() => host.querySelector<HTMLButtonElement>("[data-connect-share]")?.click());
    await wait(100);
    expect(posts).toEqual([[{ type: "moolam:address", address: WALLET }, "https://acme.example"]]);
    expect(host.textContent).toContain("Done. Taking you back to Acme Studio.");
    await wait(popup.CLOSE_AFTER_MS + 100);
    expect(order).toEqual(["post", "close"]);
  }, 10_000);

  it("connect: Cancel posts nothing and still takes the person back", async () => {
    withOpener();
    watchClose();
    const host = await mount(panel({ origin: "https://acrne.example", name: null }, true, true));
    act(() => host.querySelector<HTMLButtonElement>("[data-connect-cancel]")?.click());
    await wait(100);
    expect(host.textContent).toContain(en.checkout.doneUnlisted);
    await wait(popup.CLOSE_AFTER_MS + 100);
    expect(order).toEqual(["close"]);
    expect(posts).toEqual([]);
  }, 10_000);

  it("connect: with no opener nothing is shared, so nothing shuts", async () => {
    const close = watchClose();
    const host = await mount(panel({ origin: "https://acme.example", name: "Acme Studio" }, true, true));
    expect(host.querySelector("[data-connect-share]")).toBeNull();
    expect(host.textContent).toContain(en.connect.noOpenerLine);
    await wait(popup.CLOSE_AFTER_MS + 100);
    expect(close).not.toHaveBeenCalled();
  }, 10_000);

  it("connect: the compact page shows the exact address and origin, with Share as the one button and Cancel quiet", async () => {
    withOpener();
    const host = await mount(panel({ origin: "https://acme.example", name: "Acme Studio" }, true, true));
    expect(host.querySelector("[data-exact-address]")?.getAttribute("data-exact-address")).toBe(WALLET);
    expect(host.querySelector("[data-asking-origin]")?.textContent).toBe("https://acme.example");
    expect(host.querySelector("[data-lock-line]")?.textContent).toBe("Sent by Acme Studio, listed by Moolam");
    expect(host.querySelector("[data-connect-share]")?.className).toContain("w-full");
    expect(host.querySelector("[data-connect-cancel]")?.className).not.toContain("bg-accent");
    expect(host.querySelectorAll("button.bg-accent, button[class*=' bg-accent ']").length).toBe(1);
  });
});

/**
 * The full pages as they were before WO-260, tag for tag and class for class:
 * each hash is of the markup with its words and inline styles taken out,
 * taken from the code before this order touched it.
 */
describe("the full-size pages at 1440 are unchanged", () => {
  const structure = (html: string) =>
    createHash("sha256")
      .update(html.replace(/ style="[^"]*"/g, "").replace(/>[^<]*</g, "><"))
      .digest("hex");
  const raw = (element: ReactElement) => renderToStaticMarkup(createElement(Provider, { locale: "en", messages: en, timeZone: "UTC" }, element));

  it.each([
    ["ready", () => sheet(model([PASSED]), LISTED), "bdeaf6d2a301356723daf47953fc4b11f39ea7320630ac88a1f7d87dcf62df76"],
    ["registered", () => sheet(model([PASSED, LANDED]), LISTED), "5037549f94716ee718279b778e0f9d57cd5a6e6fe6c99393714940841e8fd6b0"],
    ["checking", () => sheet(model([{ type: "gate", gate: { at: "checking" } }]), null), "fbd3154d1f04d1b36f7b2af736c9b8e8cd6735b183474edff7c9348c17e58dee"],
    ["signed out", () => sheet(signedOut, null), "1e2ef48a398765722903bbf6ff71c05481d5fc2d57cf668763a3d085f5cb3dfa"],
    ["connect listed", () => panel({ origin: "https://acme.example", name: "Acme Studio" }, true), "13eef2164440b22503087014afd0ea63c025c78f72baedb92a6276e8aed8f820"],
    ["connect unlisted", () => panel({ origin: "https://acrne.example", name: null }, true), "045e82cdd381644f277a43b969364944ef9d3380d042125f2ae360c120419c38"],
    ["connect signed out", () => panel({ origin: "https://acme.example", name: "Acme Studio" }, false), "953f0600a3df905e38ac2e7630161b0afea6803f7a0e7343fc2721b608d894d6"],
    ["connect no site", () => panel({ origin: null, name: null }, null), "a0ad90245b8572642949c9ed63d75c2bac54b6d72b53f47598b2c5bd0bee64eb"],
  ] as const)("%s", (_, element, hash) => {
    expect(structure(raw(element()))).toBe(hash);
  });

  it("stays the full page in a wide window that has an opener", async () => {
    withOpener();
    Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true, writable: true });
    const host = await mount(sheet(model([PASSED]), LISTED));
    expect(host.querySelector("[data-checkout]")).toBeNull();
    expect(host.querySelector("[data-stamp-stage]")).not.toBeNull();

    Object.defineProperty(window, "innerWidth", { value: 480, configurable: true, writable: true });
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(host.querySelector("[data-checkout]")).not.toBeNull();
    Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true, writable: true });
  });
});
