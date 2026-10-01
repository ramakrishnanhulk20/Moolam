import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";
import type { Hex } from "viem";

// The studio only mounts its hook under a configured app id, and nothing here loads
// a .env file, so the id is set before the screens are imported and read it.
process.env.NEXT_PUBLIC_PRIVY_APP_ID = "test-app-id";

// Privy's own hooks are the thing under test: called without their provider they
// print "was called outside the PrivyProvider component" on every render. Spies in
// their place count the calls a screen makes, and answer what the SDK answers when
// it has not signed anyone in yet.
const privy = vi.hoisted(() => {
  const NOOP = () => undefined;
  const NONE = async () => undefined;
  return {
    usePrivy: vi.fn(() => ({
      ready: false,
      authenticated: false,
      user: null,
      login: NOOP,
      logout: NOOP,
      getAccessToken: async () => null,
    })),
    useWallets: vi.fn(() => ({ wallets: [] })),
    useSendTransaction: vi.fn(() => ({ sendTransaction: NONE })),
    useSigners: vi.fn(() => ({ addSigners: NONE, removeSigners: NONE })),
    // The resolve console's publish step signs the reasons with the wallet.
    useSignTypedData: vi.fn(() => ({ signTypedData: NONE })),
  };
});

vi.mock("@privy-io/react-auth", () => privy);

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown }) =>
    createElement("a", { href: props.href }, props.children as never),
  useRouter: () => ({ refresh: () => undefined }),
}));

// Each panel reaches its own file through next/dynamic, which hands the component back
// only once that chunk has been fetched, and a server render never waits for it. Every
// boundary is collected here and awaited once, so the cases below render the panel and
// not its empty loading state.
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

const { WalletMounted } = await import("@/components/providers/WalletProvider");
const { StudioScreen } = await import("@/components/studio/StudioScreen");
const { ResolveConsole } = await import("@/components/resolve/ResolveConsole");
const { DisputePanel } = await import("@/components/passport/DisputePanel");
const { EditPanel } = await import("@/components/passport/EditPanel");
const { ConsentPanel } = await import("@/components/passport/ConsentPanel");

// A chunk that arrives can start loaders of its own (the studio's panels pull
// in the sealed file card), so this waits until a round adds none. Left to
// finish after the last test, those loads end the run with a teardown error.
for (let seen = -1; seen !== chunks.pending.length; ) {
  seen = chunks.pending.length;
  await Promise.all(chunks.pending);
}

const PASSPORT = `0x${"5c".repeat(32)}` as Hex;
const OWNER = "0x551610a063BcAd79e6bd25dc55cEe92Ba3FD960a" as Hex;
const RESOLVER = "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c" as Hex;

/** Every hook the SDK hands out that this app calls. */
const HOOKS = [privy.usePrivy, privy.useWallets, privy.useSendTransaction, privy.useSigners];

function render(node: ReactElement, mounted: boolean): string {
  const Intl = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
    children?: ReactNode;
  }>;
  const tree = mounted ? createElement(WalletMounted.Provider, { value: true }, node) : node;
  return renderToStaticMarkup(createElement(Intl, { locale: "en", messages: en, timeZone: "Asia/Kolkata" }, tree));
}

const SCREENS = {
  studio: () => createElement(StudioScreen),
  resolve: () => createElement(ResolveConsole, { resolver: RESOLVER, disputes: [] }),
  dispute: () => createElement(DisputePanel, { passportId: PASSPORT, owner: OWNER, disputeOpen: false }),
  edit: () => createElement(EditPanel, { parentId: PASSPORT, owner: OWNER }),
  consent: () =>
    createElement(ConsentPanel, {
      passportId: PASSPORT,
      owner: OWNER,
      standing: { stated: false, entry: null },
      minInterval: 600,
    }),
} as const;

beforeEach(() => {
  for (const hook of HOOKS) {
    hook.mockClear();
  }
});

describe("what a screen does before the wallet provider is mounted", () => {
  it.each(Object.keys(SCREENS) as (keyof typeof SCREENS)[])("%s calls no Privy hook", (screen) => {
    render(SCREENS[screen](), false);
    for (const hook of HOOKS) {
      expect(hook).not.toHaveBeenCalled();
    }
  });

  it("paints the studio's waiting card, not a blank panel", () => {
    const markup = render(SCREENS.studio(), false);
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain(en.studio.opening);
    expect(markup).toContain(en.studio.signedOut.heading);
    expect(markup).toContain(en.studio.receipt.heading);
  });

  it("paints the resolve console's own frame", () => {
    const markup = render(SCREENS.resolve(), false);
    expect(markup).toContain(en.resolve.resolverLabel);
    expect(markup).toContain(en.resolve.creditUnread);
    expect(markup).toContain(en.resolve.empty);
    // The sign-in block only holds its place: unseen, out of the reading
    // order, and a button nobody can press before the wallet is up.
    const held = markup.slice(markup.indexOf("data-sign-in-held"));
    const button = `>${en.resolve.signIn}</button>`;
    expect(markup.split(button).length - 1).toBe(1);
    expect(markup.indexOf(button)).toBeGreaterThan(markup.indexOf("data-sign-in-held"));
    expect(held.slice(0, held.indexOf(">"))).toContain('aria-hidden="true"');
    expect(held.slice(0, held.indexOf(">"))).toContain("invisible");
    expect(held).toMatch(/<button[^>]*disabled=""[^>]*tabindex="-1"/);
  });

  it("paints nothing at all for the three passport panels", () => {
    expect(render(SCREENS.dispute(), false)).toBe("");
    expect(render(SCREENS.edit(), false)).toBe("");
    expect(render(SCREENS.consent(), false)).toBe("");
  });
});

describe("what the gate paints against what the hook paints", () => {
  it("gives the studio the same markup the not-ready hook does", () => {
    const gated = render(SCREENS.studio(), false);
    const hooked = render(SCREENS.studio(), true);
    expect(privy.usePrivy).toHaveBeenCalled();
    expect(gated).toBe(hooked);
  });

  it("gives the resolve console the same markup the not-ready hook does", () => {
    const gated = render(SCREENS.resolve(), false);
    const hooked = render(SCREENS.resolve(), true);
    expect(privy.usePrivy).toHaveBeenCalled();
    expect(gated).toBe(hooked);
  });
});

describe("what a screen does once the wallet provider is mounted", () => {
  it.each(Object.keys(SCREENS) as (keyof typeof SCREENS)[])("%s runs its hook", (screen) => {
    render(SCREENS[screen](), true);
    expect(privy.usePrivy).toHaveBeenCalled();
    expect(privy.useWallets).toHaveBeenCalled();
  });
});
