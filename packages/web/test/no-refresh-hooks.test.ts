// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Hex } from "viem";
import type { PublishDesk } from "@/lib/disputes/usePublishReasons";
import type { ClaimConfirm } from "@/lib/claims/useClaimConfirm";
import type { HeldPassports } from "@/components/mine/held";

/**
 * The hooks that write to a passport call refreshPassport (WO-332 steps 2 to 4):
 * publishing reasons does it before the screen says done, a claims confirm does it
 * for every confirmed id one after another (24 at most), the confirm card re-reads
 * the held list at 0, 30 and 90 seconds, and the held list reads again when asked
 * without blanking a good answer.
 * Does NOT cover a real wallet, a real Privy prompt or the server action itself: each is stood in for.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WALLET = "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c" as Hex;
const PASSPORT = `0x${"5c".repeat(32)}` as Hex;
const HASH = `0x${"9a".repeat(32)}` as Hex;
const URI = `ipfs://bafkreid${"r".repeat(52)}`;

const seen = vi.hoisted(() => ({
  /** Every refreshPassport call, in the order it started. */
  refreshed: [] as string[],
  running: 0,
  mostRunning: 0,
  failRefresh: false,
  /** When set, refreshPassport waits for it, so a test can look at the screen while the call is out. */
  gate: undefined as Promise<void> | undefined,
  desk: undefined as unknown,
  heldReads: 0,
  heldAnswers: [] as unknown[],
  onDone: undefined as ((txHash: Hex, rows: unknown[]) => void) | undefined,
}));

vi.mock("@/lib/passport/refresh", () => ({
  refreshPassport: async (id: string) => {
    seen.refreshed.push(id);
    seen.running += 1;
    seen.mostRunning = Math.max(seen.mostRunning, seen.running);
    await (seen.gate ?? new Promise((done) => setTimeout(done, 0)));
    seen.running -= 1;
    if (seen.failRefresh) {
      throw new Error("the server did not answer");
    }
  },
}));

vi.mock("@privy-io/react-auth", () => ({
  usePrivy: () => ({ getAccessToken: async () => "token", user: null, login: () => undefined, authenticated: true }),
  useWallets: () => ({ wallets: [{ walletClientType: "privy", address: WALLET }] }),
  useSignTypedData: () => ({ signTypedData: async () => ({ signature: `0x${"11".repeat(65)}` }) }),
  useSendTransaction: () => ({ sendTransaction: async () => ({ hash: HASH }) }),
}));

vi.mock("@/lib/chain/client", async (load) => ({
  ...(await load<typeof import("@/lib/chain/client")>()),
  chain: {
    readContract: async () => false,
    simulateContract: async () => ({}),
    getBlockNumber: async () => 100n,
    getBalance: async () => 0n,
  },
}));
vi.mock("@/lib/chain/registry", async (load) => ({
  ...(await load<typeof import("@/lib/chain/registry")>()),
  getDispute: async () => ({ challenger: WALLET, bond: 10n ** 18n, evidenceHash: `0x${"ab".repeat(32)}`, status: 2, openedAt: 5n }),
}));
vi.mock("@/lib/chain/time", () => ({ headTimestamp: async () => 1_790_000_000n }));
vi.mock("@/lib/studio/wallet", () => ({ ensureMonad: async () => undefined }));
vi.mock("@/lib/disputes/publishReasons", async (load) => ({
  ...(await load<typeof import("@/lib/disputes/publishReasons")>()),
  pinReasons: async () => ({ ok: true, reasonsURI: URI }),
  confirmPublish: async () => ({ hash: HASH, published: { reasonsURI: URI } }),
}));

vi.mock("@/lib/claims/confirm", async (load) => ({
  ...(await load<typeof import("@/lib/claims/confirm")>()),
  runConfirm: async (_input: unknown, _deps: unknown, emit: (event: { at: "done"; txHash: Hex }) => void) => {
    emit({ at: "done", txHash: HASH });
  },
}));
vi.mock("@/lib/claims/art", () => ({ artFor: async () => ({}) }));

vi.mock("next/dynamic", () => ({
  default: () => (props: { onDone: (txHash: Hex, rows: unknown[]) => void }) => {
    seen.onDone = props.onDone;
    return null;
  },
}));
vi.mock("@/lib/claims/useClaims", () => ({
  useClaims: () => ({
    answer: { offers: [], waiting: [], standing: [], muted: [] },
    status: "idle",
    refusal: null,
    busy: {},
    failures: {},
    watching: false,
    actions: { reload: () => undefined, signIn: () => undefined },
  }),
}));
vi.mock("@/lib/claims/usePendingConfirm", () => ({
  holderReads: {},
  usePendingConfirm: () => ({ status: "idle", groups: [], reread: () => undefined }),
}));
vi.mock("@/components/claims/ClaimsView", () => ({
  ClaimsView: (props: { renderConfirm: (group: unknown) => ReactNode }) =>
    props.renderConfirm({ key: "group", ids: [], entries: [], terms: {} }),
}));

vi.mock("@/lib/data/passports", () => ({
  passportsHeldNotMade: async () => {
    seen.heldReads += 1;
    const answer = seen.heldAnswers.shift();
    if (answer instanceof Error) {
      throw answer;
    }
    return answer ?? [];
  },
  passportHandover: async () => "unknown",
}));
vi.mock("@/lib/data/platform-label", () => ({
  heldPlatformList: async () => ({}),
  handoverFacts: () => ({}),
  creditFrom: () => null,
  labelFrom: () => null,
}));

const { usePublishReasons } = await import("@/lib/disputes/usePublishReasons");
const { useClaimConfirm } = await import("@/lib/claims/useClaimConfirm");
const { ClaimsSection } = await import("@/components/claims/ClaimsSection");
const { useHeldPassports, rereadHeldPassports } = await import("@/components/mine/held");

const roots: Root[] = [];

async function mount(node: ReactNode): Promise<Root> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(node));
  return root;
}

beforeEach(() => {
  seen.refreshed.length = 0;
  seen.running = 0;
  seen.mostRunning = 0;
  seen.failRefresh = false;
  seen.gate = undefined;
  seen.desk = undefined;
  seen.heldReads = 0;
  seen.heldAnswers.length = 0;
  seen.onDone = undefined;
});

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.replaceChildren();
});

describe("publishing the reasons", () => {
  async function publish(): Promise<PublishDesk> {
    function Probe() {
      const desk = usePublishReasons();
      seen.desk = desk;
      return null;
    }
    await mount(createElement(Probe));
    await act(async () => (seen.desk as PublishDesk).setText(PASSPORT, "The evidence showed one thing.\n\nThe rule says another."));
    await act(async () => {
      await (seen.desk as PublishDesk).publish(PASSPORT);
    });
    return seen.desk as PublishDesk;
  }

  it("expires the passport's held page once the publish is confirmed, and says done only after that call is back", async () => {
    let open!: () => void;
    seen.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    function Probe() {
      seen.desk = usePublishReasons();
      return null;
    }
    await mount(createElement(Probe));
    const phase = () => (seen.desk as PublishDesk).steps[PASSPORT.toLowerCase()]?.phase;
    await act(async () => (seen.desk as PublishDesk).setText(PASSPORT, "The evidence showed one thing.\n\nThe rule says another."));

    // Outside act, so the screen redraws on its own while the call is held open.
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    try {
      const sent = (seen.desk as PublishDesk).publish(PASSPORT);
      await vi.waitFor(() => expect(seen.refreshed).toEqual([PASSPORT]));
      await vi.waitFor(() => expect(phase()).toBe("confirming"));
      await new Promise((later) => setTimeout(later, 50));
      expect(phase()).toBe("confirming");

      open();
      await sent;
      await vi.waitFor(() => expect(phase()).toBe("done"));
      expect(seen.refreshed).toEqual([PASSPORT]);
    } finally {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    }
  });

  it("still says done when the server call fails, because the publish itself landed", async () => {
    seen.failRefresh = true;

    const desk = await publish();

    expect(seen.refreshed).toEqual([PASSPORT]);
    expect(desk.steps[PASSPORT.toLowerCase()].phase).toBe("done");
  });
});

describe("confirming 'These are mine'", () => {
  const ids = (count: number) => Array.from({ length: count }, (_, index) => `0x${(index + 1).toString(16).padStart(64, "0")}` as Hex);

  async function confirmed(group: Hex[]): Promise<ClaimConfirm> {
    let hook: ClaimConfirm | undefined;
    function Probe() {
      hook = useClaimConfirm({
        group: { key: "k", ids: group, entries: [], terms: {} } as never,
        wallet: WALLET,
        onDone: (txHash, rows) => seen.onDone?.(txHash, rows),
      });
      return null;
    }
    await mount(createElement(Probe));
    await act(async () => hook?.actions.confirm());
    await vi.waitFor(() => expect(seen.running).toBe(0));
    return hook as ClaimConfirm;
  }

  it("expires the page of every confirmed id, one after another", async () => {
    const group = ids(3);

    const hook = await confirmed(group);

    expect(hook.step).toBe("done");
    expect(seen.refreshed).toEqual(group);
    expect(seen.mostRunning).toBe(1);
  });

  it("stops at 24 ids when a batch holds more", async () => {
    const group = ids(32);

    await confirmed(group);
    await vi.waitFor(() => expect(seen.refreshed).toHaveLength(24));

    expect(seen.refreshed).toEqual(group.slice(0, 24));
    expect(seen.mostRunning).toBe(1);
  });

  it("skips a failed call and carries on with the next id", async () => {
    seen.failRefresh = true;
    const group = ids(3);

    const hook = await confirmed(group);
    await vi.waitFor(() => expect(seen.refreshed).toHaveLength(3));

    expect(hook.step).toBe("done");
  });
});

describe("the confirm card re-reading the held list", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  /** The held list's listener, standing in for the grid on the same page. */
  function listen(): void {
    function Grid() {
      const held = useHeldPassports(WALLET);
      seen.desk = held;
      return null;
    }
    roots.push(createRoot(document.body.appendChild(document.createElement("div"))));
    act(() => roots[roots.length - 1].render(createElement(Grid)));
  }

  it("asks at once, then 30 seconds and 90 seconds after a confirm is done", async () => {
    listen();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const afterMount = seen.heldReads;
    await mount(createElement(ClaimsSection, { wallet: WALLET }));

    act(() => seen.onDone?.(HASH, []));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(seen.heldReads - afterMount).toBe(1);

    await act(async () => vi.advanceTimersByTimeAsync(29_999));
    expect(seen.heldReads - afterMount).toBe(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(seen.heldReads - afterMount).toBe(2);

    await act(async () => vi.advanceTimersByTimeAsync(59_999));
    expect(seen.heldReads - afterMount).toBe(2);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(seen.heldReads - afterMount).toBe(3);
  });

  it("asks nothing more once the section has gone", async () => {
    listen();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const afterMount = seen.heldReads;
    const root = await mount(createElement(ClaimsSection, { wallet: WALLET }));

    act(() => seen.onDone?.(HASH, []));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    act(() => root.unmount());
    await act(async () => vi.advanceTimersByTimeAsync(120_000));

    expect(seen.heldReads - afterMount).toBe(1);
  });
});

describe("the held list reading again", () => {
  const status = () => (seen.desk as HeldPassports).status;

  function mountHeld(): Promise<Root> {
    function Grid() {
      seen.desk = useHeldPassports(WALLET);
      return null;
    }
    return mount(createElement(Grid));
  }

  it("reads once on mount and again each time it is asked, from outside or by its own reread", async () => {
    await mountHeld();
    expect(seen.heldReads).toBe(1);

    await act(async () => rereadHeldPassports());
    expect(seen.heldReads).toBe(2);

    await act(async () => (seen.desk as HeldPassports).reread());
    expect(seen.heldReads).toBe(3);
    expect(status()).toBe("ready");
  });

  it("keeps the rows on screen when the second read fails", async () => {
    await mountHeld();
    expect(status()).toBe("ready");

    seen.heldAnswers.push(new Error("the index did not answer"));
    await act(async () => rereadHeldPassports());

    expect(seen.heldReads).toBe(2);
    expect(status()).toBe("ready");
  });

  it("says unreadable when the very first read fails, as it did before", async () => {
    seen.heldAnswers.push(new Error("the index did not answer"));

    await mountHeld();

    expect(status()).toBe("unreadable");
  });

  it("stops listening once the list has gone", async () => {
    const root = await mountHeld();
    act(() => root.unmount());

    await act(async () => rereadHeldPassports());

    expect(seen.heldReads).toBe(1);
  });
});
