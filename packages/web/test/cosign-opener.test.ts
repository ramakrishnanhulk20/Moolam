// @vitest-environment jsdom
import { act, createElement, type FunctionComponent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import en from "@/messages/en.json";

/**
 * P10 run in a browser-like page: the co-sign page, mounted with its real
 * hook, is sent forged messages the way an opener could send them, and
 * nothing it draws or would sign moves. It never even listens for them.
 */

const HANDLE = "0123456789abcdef0123456789abcdef";
const WALLET = "0xc3714B31A5F300D7A79f72C7AEC61240D2f384E7" as Hex;
const EXACT = `0x${"7a".repeat(32)}` as Hex;

const spies = vi.hoisted(() => ({
  sendTransaction: vi.fn(),
  login: vi.fn(),
  open: vi.fn(),
  status: vi.fn(),
}));

vi.mock("@privy-io/react-auth", () => ({
  usePrivy: () => ({
    ready: true,
    authenticated: true,
    user: null,
    login: spies.login,
    logout: vi.fn(),
    getAccessToken: async () => "privy-token",
  }),
  useWallets: () => ({ wallets: [{ walletClientType: "privy", address: WALLET }], ready: true }),
  useSendTransaction: () => ({ sendTransaction: spies.sendTransaction }),
}));
vi.mock("@/lib/studio/usePasskeyBinding", () => ({
  usePasskeyBinding: () => ({
    status: "bound",
    passkey: { qx: `0x${"01".repeat(32)}`, qy: `0x${"02".repeat(32)}` },
    credentialId: undefined,
    error: null,
    refresh: () => undefined,
    remember: () => undefined,
  }),
}));
vi.mock("@/lib/cosign/agent", () => ({ cosignAgentFacts: async () => null }));
vi.mock("@/lib/chain/time", () => ({ headTimestamp: async () => 1_790_000_000n }));
vi.mock("@/lib/cosign/record", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/cosign/record")>();
  return { ...real, openRecord: spies.open, recordStatus: spies.status };
});
vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
}));
vi.mock("@/components/passport/Picture", () => ({
  Picture: () => createElement("span", { "data-picture": true }),
}));

const { CosignLive } = await import("@/components/cosign/CosignLive");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WAITING = {
  kind: "record",
  record: {
    state: "creator-set",
    agentId: "4242",
    platform: { name: "Acme Studio", agentId: "4242" },
    exactHash: EXACT,
    passport: {
      exactHash: EXACT,
      parentId: `0x${"00".repeat(32)}`,
      creator: WALLET,
      generatorAgentId: "4242",
      phash: "1",
      blockhash256: `0x${"ab".repeat(32)}`,
      manifestHash: `0x${"cd".repeat(32)}`,
      kind: 0,
      fingerprintVersion: 1,
      metadataURI: "ipfs://bafkreimetadata000000000000000",
      deadline: "1790001800",
    },
    files: Object.fromEntries(
      ["image", "thumbnail", "manifest", "metadata"].map((role) => [
        role,
        { cid: `bafkrei${role}0000000000000000`, uri: `ipfs://bafkrei${role}0000000000000000`, gatewayUrl: `https://g.example/${role}`, bytes: 10 },
      ]),
    ),
    openBy: 1_790_000_000,
    digest: `0x${"01".repeat(32)}`,
  },
};

const roots: Root[] = [];
let listened: string[] = [];

beforeEach(() => {
  window.location.hash = HANDLE;
  spies.open.mockResolvedValue(WAITING);
  spies.status.mockResolvedValue(WAITING);
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
  listened = [];
  const add = window.addEventListener.bind(window);
  vi.spyOn(window, "addEventListener").mockImplementation((type: string, ...rest: unknown[]) => {
    listened.push(type);
    return (add as (...args: unknown[]) => void)(type, ...rest);
  });
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  spies.sendTransaction.mockReset();
  spies.login.mockReset();
});

async function settle(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Lets every entrance and swap finish, so what is compared is what the page says, not where a fade had got to. */
async function rest(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 900));
  });
  await settle();
}

/** The page as a reader and a script see it: every attribute and word, with the in-flight animation styles left out. */
function drawn(host: HTMLElement): string {
  return host.innerHTML.replace(/ style="[^"]*"/g, "");
}

async function mount(): Promise<HTMLDivElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{ locale: string; messages: unknown; timeZone: string; children?: unknown }>;
  await act(async () => root.render(createElement(Provider, { locale: "en", messages: en, timeZone: "UTC" }, createElement(CosignLive))));
  await settle();
  return host;
}

describe("P10: a message from the opener changes nothing drawn or signed", () => {
  it("reads the handle from the fragment and opens the record with it", async () => {
    await mount();
    expect(spies.open).toHaveBeenCalledWith(HANDLE, "privy-token");
  });

  it("ignores forged messages of every shape and never registers a listener for them", async () => {
    const host = await mount();
    await rest();
    expect(host.querySelector("article")?.getAttribute("data-cosign-state")).toBe("waitingAgent");
    const before = drawn(host);
    const opened = spies.open.mock.calls.length;

    const forged: unknown[] = [
      { type: "moolam:registered", passportId: EXACT, txHash: `0x${"5e".repeat(32)}` },
      { state: "ready", digest: `0x${"99".repeat(32)}` },
      { type: "moolam:address", address: "0x0000000000000000000000000000000000000001" },
      { agentSignature: `0x${"11".repeat(65)}`, deadline: "9999999999" },
      "sign",
    ];
    for (const data of forged) {
      await act(async () => {
        window.dispatchEvent(new MessageEvent("message", { data, origin: "https://acme.example" }));
      });
    }
    await rest();

    expect(drawn(host)).toBe(before);
    expect(spies.open.mock.calls.length).toBe(opened);
    expect(host.querySelector("article")?.getAttribute("data-cosign-state")).toBe("waitingAgent");
    expect(host.querySelector('[data-press="sign"]')).toBeNull();
    expect(spies.sendTransaction).not.toHaveBeenCalled();
    expect(listened).not.toContain("message");
  });
});
