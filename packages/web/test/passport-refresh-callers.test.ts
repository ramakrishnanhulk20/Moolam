// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type FunctionComponent, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import type { Hex } from "viem";
import en from "@/messages/en.json";
import type { FlagPassport } from "@/lib/disputes/useFlagPassport";
import type { ResolveDisputes } from "@/lib/disputes/useResolveDisputes";
import type { PassportEdit } from "@/lib/passport/useEditPassport";

// The two panels fetch their live halves through next/dynamic, and in jsdom that
// chunk resolves after act has returned, which would leave the hook's callback
// never handed over. Loading both once here puts them in the module cache first.
await Promise.all([import("@/components/passport/Editor"), import("@/components/passport/Challenge")]);

/** What each write did, in the order it happened. */
const order = vi.hoisted(() => ({ steps: [] as string[], dropped: [] as string[] }));

// The three hooks are where the wallet lives, so each one hands back a standing
// this file sets and keeps the callback the panel gave it.
const held = vi.hoisted(() => ({
  onLanded: undefined as (() => void) | undefined,
  onFlagged: undefined as (() => void) | undefined,
  onSettled: undefined as (() => void) | undefined,
}));

vi.mock("@/lib/passport/refresh", () => ({
  refreshPassport: async (id: string) => {
    // A tick of its own: a caller that does not wait for this would have asked
    // for the page again before the hold was dropped, and the order would show it.
    await new Promise((done) => setTimeout(done, 0));
    order.dropped.push(id);
    order.steps.push("dropped");
  },
}));

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown }) =>
    createElement("a", { href: props.href }, props.children as never),
  useRouter: () => ({ refresh: () => order.steps.push("re-read") }),
}));

const editStub = vi.hoisted(() => ({ current: { ready: false } as unknown as PassportEdit }));
const flagStub = vi.hoisted(() => ({ current: { ready: false } as unknown as FlagPassport }));
const deskStub = vi.hoisted(() => ({ current: null as unknown as ResolveDisputes }));

vi.mock("@/lib/passport/useEditPassport", () => ({
  useEditPassport: (input: { onLanded?: () => void }) => {
    held.onLanded = input.onLanded;
    return editStub.current;
  },
}));

vi.mock("@/lib/disputes/useFlagPassport", () => ({
  useFlagPassport: (input: { onLanded?: () => void }) => {
    held.onFlagged = input.onLanded;
    return flagStub.current;
  },
}));

vi.mock("@/lib/disputes/useResolveDisputes", () => ({
  useResolveDisputes: (input: { onSettled?: () => void }) => {
    held.onSettled = input.onSettled;
    return deskStub.current;
  },
}));

const { WalletMounted } = await import("@/components/providers/WalletProvider");
const { EditPanel } = await import("@/components/passport/EditPanel");
const { DisputePanel } = await import("@/components/passport/DisputePanel");
const { ResolveConsole } = await import("@/components/resolve/ResolveConsole");

const PASSPORT = `0x${"5c".repeat(32)}` as Hex;
const OWNER = "0x551610a063BcAd79e6bd25dc55cEe92Ba3FD960a" as Hex;
const RESOLVER = "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c" as Hex;
const NOOP = () => undefined;
const ASYNC_NOOP = async () => undefined;

function desk(over: Partial<ResolveDisputes> = {}): ResolveDisputes {
  return {
    ready: true,
    authenticated: true,
    wallet: RESOLVER,
    isResolver: true,
    credit: 0n,
    busy: null,
    confirming: false,
    settled: {},
    failure: null,
    withdrawing: false,
    withdrawn: false,
    ...over,
    actions: { settle: ASYNC_NOOP, withdraw: ASYNC_NOOP, recheck: ASYNC_NOOP, signIn: NOOP },
  };
}

async function mount(node: ReactElement): Promise<void> {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;
  const host = document.createElement("div");
  document.body.append(host);

  await act(async () => {
    createRoot(host).render(
      createElement(
        Provider,
        { locale: "en", messages: en, timeZone: "Asia/Kolkata" },
        createElement(WalletMounted.Provider, { value: true }, node),
      ),
    );
  });
}

beforeEach(() => {
  order.steps.length = 0;
  order.dropped.length = 0;
});

describe("what each confirmed write does before it asks for the page again", () => {
  it("drops the parent's page after an edit lands, and only then re-reads", async () => {
    await mount(createElement(EditPanel, { parentId: PASSPORT, owner: OWNER }));

    await act(async () => {
      await held.onLanded?.();
    });

    expect(order.dropped).toEqual([PASSPORT]);
    expect(order.steps).toEqual(["dropped", "re-read"]);
  });

  it("drops the challenged passport's page after a flag is confirmed, and only then re-reads", async () => {
    await mount(createElement(DisputePanel, { passportId: PASSPORT, owner: OWNER, disputeOpen: false }));

    await act(async () => {
      await held.onFlagged?.();
    });

    expect(order.dropped).toEqual([PASSPORT]);
    expect(order.steps).toEqual(["dropped", "re-read"]);
  });

  it("drops the settled dispute's own passport page from the resolver's desk", async () => {
    deskStub.current = desk({ busy: PASSPORT, confirming: true });
    await mount(createElement(ResolveConsole, { resolver: RESOLVER, disputes: [] }));

    await act(async () => {
      await held.onSettled?.();
    });

    expect(order.dropped).toEqual([PASSPORT]);
    expect(order.steps).toEqual(["dropped", "re-read"]);
  });
});
