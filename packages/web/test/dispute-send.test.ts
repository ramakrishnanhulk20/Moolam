import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Hex } from "viem";
import { ConfirmTimeout } from "@/lib/studio/confirm";
import type { FlagPassport } from "@/lib/disputes/useFlagPassport";
import type { ResolveDisputes } from "@/lib/disputes/useResolveDisputes";

/**
 * Both dispute hooks, driven from a bare component.
 *
 * Privy only runs in a browser, so its three hooks are stood in for here. What
 * this file is after is the one argument that cannot be checked by reading the
 * screen: the account each send goes from. A session can hold more than one
 * wallet, and a transaction simulated against one of them must not go out from
 * another.
 */

const WALLET = "0x85a88Ca81Ff5F681D96AB86fA60ccB8452a139a6" as Hex;
const OWNER = "0x551610a063BcAd79e6bd25dc55cEe92Ba3FD960a" as Hex;
const PASSPORT = `0x${"5c".repeat(32)}` as Hex;
const HASH = `0x${"3f".repeat(32)}` as Hex;
const REASON = "The same file is on a stock library from 2019, under a different name.";

const privy = vi.hoisted(() => ({
  sendTransaction: vi.fn(),
  wallets: [] as unknown[],
}));

const chainReads = vi.hoisted(() => ({ call: vi.fn(), getBalance: vi.fn(), getTransactionReceipt: vi.fn() }));
const registry = vi.hoisted(() => ({ disputeBond: vi.fn(), withdrawable: vi.fn(), getDispute: vi.fn() }));
const waits = vi.hoisted(() => ({ confirmFlag: vi.fn(), confirmResolve: vi.fn(), confirmWithdraw: vi.fn() }));

vi.mock("@privy-io/react-auth", () => ({
  usePrivy: () => ({ ready: true, authenticated: true, login: () => undefined }),
  useWallets: () => ({ wallets: privy.wallets }),
  useSendTransaction: () => ({ sendTransaction: privy.sendTransaction }),
}));

vi.mock("@/lib/chain/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/chain/client")>();
  return { ...actual, chain: chainReads };
});

vi.mock("@/lib/chain/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/chain/registry")>();
  return { ...actual, ...registry };
});

vi.mock("@/lib/studio/wallet", () => ({ ensureMonad: vi.fn().mockResolvedValue(undefined) }));

vi.mock("@/lib/disputes/confirm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/disputes/confirm")>();
  return { ...actual, ...waits };
});

const { useFlagPassport } = await import("@/lib/disputes/useFlagPassport");
const { useResolveDisputes } = await import("@/lib/disputes/useResolveDisputes");

/** Renders the hook once and hands back what it returned. Nothing is mounted. */
function flagHook(): FlagPassport {
  let captured: FlagPassport | null = null;

  function Probe() {
    const flag = useFlagPassport({ passportId: PASSPORT, owner: OWNER });
    captured = flag;
    // The reason lives in the hook's own reducer, and this is the only way to
    // type into it without a DOM. React re-runs the component on this.
    if (flag.state.reason !== REASON) {
      flag.actions.setReason(REASON);
    }
    return null;
  }

  renderToStaticMarkup(createElement(Probe));
  if (captured === null) {
    throw new Error("the probe never rendered");
  }
  return captured;
}

function resolveHook(): ResolveDisputes {
  let captured: ResolveDisputes | null = null;

  function Probe() {
    captured = useResolveDisputes({ resolver: WALLET });
    return null;
  }

  renderToStaticMarkup(createElement(Probe));
  if (captured === null) {
    throw new Error("the probe never rendered");
  }
  return captured;
}

beforeEach(() => {
  privy.wallets = [{ address: WALLET, walletClientType: "privy" }];
  privy.sendTransaction.mockResolvedValue({ hash: HASH });
  chainReads.call.mockResolvedValue({ data: "0x" });
  chainReads.getBalance.mockResolvedValue(3_000_000_000_000_000_000n);
  chainReads.getTransactionReceipt.mockResolvedValue({ blockNumber: 41_273_109n });
  registry.disputeBond.mockResolvedValue(1_000_000_000_000_000_000n);
  registry.withdrawable.mockResolvedValue(1_000_000_000_000_000_000n);
  waits.confirmFlag.mockResolvedValue({ hash: HASH, blockNumber: 41_273_109n });
  waits.confirmResolve.mockResolvedValue({ hash: HASH, blockNumber: 41_273_109n, outcome: "upheld" });
  waits.confirmWithdraw.mockResolvedValue({ hash: HASH });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("which account a dispute write goes out from", () => {
  it("names the wallet on a flag, the one the call was simulated for", async () => {
    await flagHook().actions.submit();

    expect(chainReads.call).toHaveBeenCalledWith(expect.objectContaining({ account: WALLET }));
    expect(privy.sendTransaction).toHaveBeenCalledTimes(1);
    expect(privy.sendTransaction.mock.calls[0][1]).toMatchObject({ sponsor: true, address: WALLET });
  });

  it("names the wallet on a settle", async () => {
    await resolveHook().actions.settle(PASSPORT, true);

    expect(chainReads.call).toHaveBeenCalledWith(expect.objectContaining({ account: WALLET }));
    expect(privy.sendTransaction.mock.calls[0][1]).toMatchObject({ sponsor: true, address: WALLET });
  });

  it("names the wallet on a withdraw", async () => {
    await resolveHook().actions.withdraw();

    expect(privy.sendTransaction.mock.calls[0][1]).toMatchObject({ sponsor: true, address: WALLET });
  });
});

describe("a write that is out is never sent twice", () => {
  it("sends one settle and no more while the wait has not answered", async () => {
    waits.confirmResolve.mockRejectedValue(new ConfirmTimeout(WALLET, HASH));

    const desk = resolveHook();
    await desk.actions.settle(PASSPORT, true);
    await desk.actions.settle(PASSPORT, true);
    await desk.actions.settle(PASSPORT, false);

    expect(privy.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it("looks again on a recheck, and still sends nothing", async () => {
    waits.confirmResolve.mockRejectedValue(new ConfirmTimeout(WALLET, HASH));

    const desk = resolveHook();
    await desk.actions.settle(PASSPORT, true);
    await desk.actions.recheck();

    expect(waits.confirmResolve).toHaveBeenCalledTimes(2);
    expect(privy.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it("sends one flag and no more while the wait has not answered", async () => {
    waits.confirmFlag.mockRejectedValue(new ConfirmTimeout(WALLET, HASH));

    const flag = flagHook();
    await flag.actions.submit();
    await flag.actions.submit();

    expect(privy.sendTransaction).toHaveBeenCalledTimes(1);
  });
});
