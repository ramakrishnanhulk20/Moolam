// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type FunctionComponent, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";
import { BaseError, ContractFunctionRevertedError, encodeErrorResult, type Abi, type Hex } from "viem";
import consentAbiJson from "../../contracts/abi/MoolamConsent.json";
import { ConfirmTimeout } from "@/lib/studio/confirm";
import type { Consent } from "@/lib/chain/consent";
import type { SetConsent } from "@/lib/consent/useSetConsent";

/**
 * The holder's send, driven from a bare component.
 *
 * Privy only runs in a browser, so its three hooks are stood in for here. What
 * this file is after is everything that happens around the one transaction: the
 * account it goes from, the refusals that are prevented rather than paid for,
 * and the order of the two things that happen once the register has shown the
 * statement.
 */

const WALLET = "0x85a88Ca81Ff5F681D96AB86fA60ccB8452a139a6" as Hex;
const STRANGER = "0x551610a063BcAd79e6bd25dc55cEe92Ba3FD960a" as Hex;
const PASSPORT = `0x${"5c".repeat(32)}` as Hex;
const HASH = `0x${"3f".repeat(32)}` as Hex;

const CLOSED: Consent = {
  aiTraining: "notAllowed",
  aiGenerativeTraining: "notAllowed",
  aiInference: "notAllowed",
  dataMining: "notAllowed",
};

const OPEN: Consent = {
  aiTraining: "allowed",
  aiGenerativeTraining: "allowed",
  aiInference: "allowed",
  dataMining: "allowed",
};

const privy = vi.hoisted(() => ({ sendTransaction: vi.fn(), wallets: [] as unknown[] }));
const chainCalls = vi.hoisted(() => ({ simulateContract: vi.fn() }));
const reads = vi.hoisted(() => ({ getConsent: vi.fn() }));
const waits = vi.hoisted(() => ({ confirmSetConsent: vi.fn() }));

/** What happened after the register showed the statement, in the order it happened. */
const order = vi.hoisted(() => ({ steps: [] as string[] }));

vi.mock("@privy-io/react-auth", () => ({
  usePrivy: () => ({ ready: true, authenticated: true, login: () => undefined }),
  useWallets: () => ({ wallets: privy.wallets }),
  useSendTransaction: () => ({ sendTransaction: privy.sendTransaction }),
}));

vi.mock("next/cache", () => ({ unstable_cache: (fn: (...args: unknown[]) => Promise<unknown>) => fn }));

vi.mock("@/lib/chain/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/chain/client")>();
  return { ...actual, chain: chainCalls };
});

vi.mock("@/lib/chain/consent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chain/consent")>()),
  getConsent: reads.getConsent,
}));

vi.mock("@/lib/consent/confirm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/consent/confirm")>()),
  confirmSetConsent: waits.confirmSetConsent,
}));

vi.mock("@/lib/studio/wallet", () => ({ ensureMonad: vi.fn().mockResolvedValue(undefined) }));

vi.mock("@/lib/passport/refresh", () => ({
  refreshPassport: async (id: string) => {
    // A tick of its own: a caller that does not wait for this would have asked
    // for the page again before the hold was dropped, and the order would show it.
    await new Promise((done) => setTimeout(done, 0));
    order.steps.push(`dropped ${id}`);
  },
}));

vi.mock("@/lib/i18n/routing", () => ({
  useRouter: () => ({ refresh: () => order.steps.push("re-read") }),
}));

const { useSetConsent } = await import("@/lib/consent/useSetConsent");
const { describeConsentFailure } = await import("@/lib/consent/failure");
const { ConsentEditor } = await import("@/components/passport/ConsentEditor");

const consentAbi = consentAbiJson as Abi;

/** A refusal exactly as viem raises one, decoded through the register's own ABI. */
function refusal(name: string, args: readonly unknown[]): BaseError {
  const reverted = new ContractFunctionRevertedError({
    abi: consentAbi,
    data: encodeErrorResult({ abi: consentAbi, errorName: name, args }),
    functionName: "setConsent",
  });
  return new BaseError("the register refused this statement", { cause: reverted });
}

/** Mounts the hook and hands back a live view of what it last returned. */
async function mount(
  standing: { writer?: string; at?: number } = {},
  minInterval = 600,
): Promise<{ read: () => SetConsent }> {
  const seen: { current: SetConsent | null } = { current: null };

  function Probe() {
    seen.current = useSetConsent({ passportId: PASSPORT, owner: WALLET, standing, minInterval });
    return null;
  }

  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    createRoot(host).render(createElement(Probe));
  });

  return {
    read: () => {
      if (seen.current === null) {
        throw new Error("the probe never rendered");
      }
      return seen.current;
    },
  };
}

beforeEach(() => {
  order.steps.length = 0;
  privy.wallets = [{ address: WALLET, walletClientType: "privy" }];
  privy.sendTransaction.mockResolvedValue({ hash: HASH });
  chainCalls.simulateContract.mockResolvedValue({ request: {} });
  reads.getConsent.mockResolvedValue({ stated: false, entry: null });
  waits.confirmSetConsent.mockResolvedValue({ hash: HASH, at: 1_789_719_047 });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("a holder writing their statement", () => {
  it("simulates for the wallet it sends from, and sends once", async () => {
    const panel = await mount();

    await act(async () => {
      await panel.read().actions.submit({ consent: CLOSED, constraintInfo: "" });
    });

    expect(chainCalls.simulateContract).toHaveBeenCalledWith(
      expect.objectContaining({
        account: WALLET,
        functionName: "setConsent",
        args: [PASSPORT, { aiTraining: 2, aiGenerativeTraining: 2, aiInference: 2, dataMining: 2 }, ""],
      }),
    );
    expect(privy.sendTransaction).toHaveBeenCalledTimes(1);
    expect(privy.sendTransaction.mock.calls[0][1]).toMatchObject({ sponsor: true, address: WALLET });
    expect(panel.read().state.step).toBe("done");
  });

  it("waits for the register to show the statement, then drops the page before asking for it again", async () => {
    const panel = await mount();
    waits.confirmSetConsent.mockImplementation(async () => {
      order.steps.push("shown by the register");
      return { hash: HASH, at: 1_789_719_047 };
    });

    await act(async () => {
      await panel.read().actions.submit({ consent: OPEN, constraintInfo: "" });
    });

    expect(order.steps).toEqual(["shown by the register", `dropped ${PASSPORT}`, "re-read"]);
    expect(waits.confirmSetConsent).toHaveBeenCalledWith(
      expect.objectContaining({ passportId: PASSPORT, wallet: WALLET, since: 0 }),
    );
  });

  it("waits past the statement that stood before the send", async () => {
    reads.getConsent.mockResolvedValue({
      stated: true,
      entry: { at: 1_789_000_000n, writer: STRANGER, consent: OPEN, constraintInfo: "" },
    });
    const panel = await mount();

    await act(async () => {
      await panel.read().actions.submit({ consent: CLOSED, constraintInfo: "" });
    });

    expect(waits.confirmSetConsent).toHaveBeenCalledWith(expect.objectContaining({ since: 1_789_000_000 }));
  });
});

describe("what the control refuses to send", () => {
  it("prevents TooSoon rather than paying for it: this wallet wrote a minute ago", async () => {
    const wroteAt = Math.floor(Date.now() / 1000) - 60;
    reads.getConsent.mockResolvedValue({
      stated: true,
      entry: { at: BigInt(wroteAt), writer: WALLET, consent: OPEN, constraintInfo: "" },
    });
    const panel = await mount({ writer: WALLET, at: wroteAt });

    expect(panel.read().opensAt).toBe(wroteAt + 600);

    await act(async () => {
      await panel.read().actions.submit({ consent: CLOSED, constraintInfo: "" });
    });

    expect(chainCalls.simulateContract).not.toHaveBeenCalled();
    expect(privy.sendTransaction).not.toHaveBeenCalled();
    expect(panel.read().state.failure).toEqual({ key: "tooSoon", at: wroteAt + 600 });
  });

  it("leaves the control open when the last statement was somebody else's", async () => {
    const panel = await mount({ writer: STRANGER, at: Math.floor(Date.now() / 1000) - 60 });
    expect(panel.read().opensAt).toBeNull();
  });

  it("sends nothing while a statement is out and unconfirmed", async () => {
    waits.confirmSetConsent.mockRejectedValue(new ConfirmTimeout(WALLET, HASH));
    const panel = await mount();

    await act(async () => {
      await panel.read().actions.submit({ consent: CLOSED, constraintInfo: "" });
      await panel.read().actions.submit({ consent: OPEN, constraintInfo: "" });
    });

    expect(privy.sendTransaction).toHaveBeenCalledTimes(1);
    expect(panel.read().state.failure?.key).toBe("confirmPending");
    expect(panel.read().state.step).toBe("confirming");

    await act(async () => {
      await panel.read().actions.recheck();
    });
    expect(waits.confirmSetConsent).toHaveBeenCalledTimes(2);
    expect(privy.sendTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("what a refusal reads as", () => {
  it("a closed wallet prompt is not an error", async () => {
    privy.sendTransaction.mockRejectedValue(Object.assign(new Error("User rejected request"), { code: 4001 }));
    const panel = await mount();

    await act(async () => {
      await panel.read().actions.submit({ consent: CLOSED, constraintInfo: "" });
    });

    expect(panel.read().state.failure).toEqual({ key: "declined", next: "again" });
    expect(panel.read().state.step).toBe("idle");
  });

  it("NotPassportHolder becomes its own sentence, and nothing is sent", async () => {
    chainCalls.simulateContract.mockRejectedValue(refusal("NotPassportHolder", [PASSPORT, STRANGER]));
    const panel = await mount();

    await act(async () => {
      await panel.read().actions.submit({ consent: CLOSED, constraintInfo: "" });
    });

    expect(panel.read().state.failure).toEqual({ key: "notHolder", reason: "NotPassportHolder", next: undefined });
    expect(privy.sendTransaction).not.toHaveBeenCalled();
  });

  it("names the second the register opens again when the chain is the one that says TooSoon", () => {
    const failure = describeConsentFailure(refusal("TooSoon", [PASSPORT, 1_789_719_647n]));
    expect(failure).toEqual({ key: "tooSoon", reason: "TooSoon", next: undefined, at: 1_789_719_647 });
  });

  it("gives the conditions errors a line with another attempt behind it", () => {
    expect(describeConsentFailure(refusal("ConstraintInfoTooLong", [400n]))).toMatchObject({
      key: "conditionsTooLong",
      next: "again",
    });
    expect(describeConsentFailure(refusal("ConstraintInfoNotPrintable", [2n]))).toMatchObject({
      key: "conditionsNotPrintable",
    });
  });

  it("falls back to one line for anything that was not a revert at all", () => {
    expect(describeConsentFailure(new Error("the endpoint refused"))).toEqual({
      key: "unknown",
      reason: "the endpoint refused",
      next: "again",
    });
  });
});

describe("the panel the holder actually sees", () => {
  // jsdom has neither of the two browser things this panel's motion asks for:
  // the media query that says whether the reader wants less movement, and the
  // observer that tells the section it has been scrolled to. Both answer here
  // the way a plain browser answers.
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });

    Object.defineProperty(window, "IntersectionObserver", {
      writable: true,
      value: class {
        observe() {}
        unobserve() {}
        disconnect() {}
        takeRecords() {
          return [];
        }
      },
    });
    globalThis.IntersectionObserver = window.IntersectionObserver;
  });

  /** Mounts the panel the way a passport page mounts it, and hands back its text. */
  async function panel(standing: { writer?: string; at?: number; consent?: Consent } = {}): Promise<string> {
    const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
      locale: string;
      messages: unknown;
      timeZone: string;
    }>;
    const node: ReactElement = createElement(ConsentEditor, {
      passportId: PASSPORT,
      owner: WALLET,
      standing:
        standing.writer === undefined
          ? { stated: false, entry: null }
          : {
              stated: true,
              entry: {
                at: standing.at ?? 0,
                writer: standing.writer,
                consent: standing.consent ?? CLOSED,
                constraintInfo: "",
              },
            },
      minInterval: 600,
    });

    const host = document.createElement("div");
    document.body.append(host);
    await act(async () => {
      createRoot(host).render(
        createElement(Provider, { locale: "en", messages: en, timeZone: "Asia/Kolkata" }, node),
      );
    });
    return host.textContent ?? "";
  }

  it("offers the three plain choices and the button to the wallet that holds the passport", async () => {
    const text = await panel();

    expect(text).toContain(en.passport.consent.control.heading);
    expect(text).toContain(en.passport.consent.control.choices.open.title);
    expect(text).toContain(en.passport.consent.control.choices.closed.title);
    expect(text).toContain(en.passport.consent.control.choices.ask.title);
    expect(text).toContain(en.passport.consent.control.submit);
  });

  it("says nothing has changed when the holder opens on their own standing statement", async () => {
    const text = await panel({ writer: WALLET, at: Math.floor(Date.now() / 1000) - 4_000 });
    expect(text).toContain(en.passport.consent.control.unchanged);
  });

  it("locks itself, in words, while the register's ten minutes are still running", async () => {
    const text = await panel({ writer: WALLET, at: Math.floor(Date.now() / 1000) - 60 });
    expect(text).toContain(en.passport.consent.control.locked.split("{")[0].trim());
  });
});
