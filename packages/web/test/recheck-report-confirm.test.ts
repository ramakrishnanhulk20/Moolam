// @vitest-environment jsdom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type FunctionComponent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { encodeAbiParameters, encodeEventTopics, TransactionReceiptNotFoundError, type Hex } from "viem";
import en from "@/messages/en.json";

/**
 * A request the runner answers from its own memory (F1).
 *
 * The runner re-checks every new picture within minutes. A reader who presses
 * afterwards gets the queue's "done" with the new request's time and the report
 * transaction from before it, so the newest verdict on chain is older than the
 * request. The time rule alone kept that as pending for half an hour. The
 * report transaction itself is on chain, though, and reading its receipt says
 * whether it really is this passport's verdict from Moolam's CRE wallet.
 *
 * Only the RPC is stubbed here. The control, the hook, the state rules and the
 * server reads are the real ones, so the whole path from the queue's word to
 * the words on the screen is under test.
 */

const PASSPORT = `0x${"7c".repeat(32)}` as Hex;
const OTHER_PASSPORT = `0x${"3d".repeat(32)}` as Hex;
const TX = `0x${"91".repeat(32)}` as Hex;
/** The CRE wallet, as the simulation receivers' deploy record names it. */
const CRE_WALLET = "0xC79620AF233a4434b03f6B57239F8A9E71B3C178" as Hex;
const STRANGER = "0x551610a063BcAd79e6bd25dc55cEe92Ba3FD960a" as Hex;

/** The report's block, in unix seconds, and a request made seven minutes after it. */
const REPORT_AT = 1_790_000_100;
const REQUESTED_AT = (REPORT_AT + 420) * 1000;

const service = vi.hoisted(() => ({ status: { state: "none" } as unknown }));

vi.mock("@/lib/verifier/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/verifier/client")>()),
  readRecheckStatus: async () => service.status,
  requestRecheck: async () => {
    throw new Error("nothing in this file presses the button");
  },
}));

const rpc = vi.hoisted(() => ({
  receipt: null as unknown,
  blockTime: 0n,
  rows: [] as unknown[],
  receipts: 0,
  attestationReads: 0,
}));

vi.mock("@/lib/chain/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/chain/client")>();
  return {
    ...actual,
    chain: {
      getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
        rpc.receipts += 1;
        if (rpc.receipt === null) {
          throw new TransactionReceiptNotFoundError({ hash });
        }
        return rpc.receipt;
      },
      getBlock: async () => ({ timestamp: rpc.blockTime }),
      readContract: async () => {
        rpc.attestationReads += 1;
        return rpc.rows;
      },
    },
  };
});

/** Every hold asked for, so how long each answer is kept can be read back. */
const holds = vi.hoisted(() => ({ filed: [] as { keyParts: string[]; revalidate?: number }[] }));
vi.mock("next/cache", () => ({
  unstable_cache: (
    fn: (...args: unknown[]) => Promise<unknown>,
    keyParts: string[],
    options: { revalidate?: number },
  ) => {
    holds.filed.push({ keyParts, revalidate: options.revalidate });
    return fn;
  },
}));

const caller = vi.hoisted(() => ({ address: "203.0.113.7" }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-real-ip": caller.address }),
}));

vi.mock("next/navigation", () => ({ useParams: () => ({ locale: "en" }) }));
vi.mock("@/lib/i18n/routing", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));
vi.mock("@/lib/passport/refresh", () => ({ refreshPassport: async () => undefined }));

const { addresses, registryAbi } = await import("@/lib/chain/client");
const { forgetCallers } = await import("@/lib/api/limit");
const { RecheckRequest } = await import("@/components/passport/RecheckRequest");
const { confirmedReport, newestChainlinkRecheck } = await import("@/lib/recheck/chain");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The registry's VerificationAttested log, as the node serves it inside a receipt. */
function attestationLog({
  passport = PASSPORT,
  receiver = addresses.simulationReceiver,
  emitter = addresses.registry,
  matched = true,
  distance = 2,
}: { passport?: Hex; receiver?: Hex; emitter?: Hex; matched?: boolean; distance?: number } = {}) {
  return {
    address: emitter,
    topics: encodeEventTopics({
      abi: registryAbi,
      eventName: "VerificationAttested",
      args: { passportId: passport, receiver },
    }),
    data: encodeAbiParameters(
      [{ type: "bool" }, { type: "uint16" }, { type: "bytes32" }],
      [matched, distance, `0x${"ab".repeat(32)}`],
    ),
  };
}

function reportReceipt(overrides: Record<string, unknown> = {}) {
  return {
    status: "success",
    from: CRE_WALLET,
    to: addresses.simulationForwarder,
    blockNumber: 108_499_297n,
    logs: [attestationLog()],
    ...overrides,
  };
}

/** The queue's word: done, for a request made after the newest verdict, naming the earlier report or, with null, none. */
function queueSaysDone(reportTx: Hex | null = TX) {
  service.status = {
    state: "known",
    status: {
      status: "done",
      requestedAt: REQUESTED_AT,
      finishedAt: REQUESTED_AT + 5_000,
      ...(reportTx === null ? {} : { reportTx }),
      matched: true,
      distance: 2,
    },
  };
}

function day(unixSeconds: number): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(unixSeconds * 1000));
}

let root: Root | null = null;
let host: HTMLElement | null = null;

/**
 * The server read remembers a miss for half a minute, in its own memory. Each
 * test starts a minute after the last, so no test inherits another's misses,
 * exactly as a later visitor would not.
 */
let clock = Date.now();

/**
 * The control as the passport page draws it. Null is a page rendered before
 * any verdict was on chain, which is where a judge who just registered stands.
 */
async function mount(recheckedOn: string | null): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
    children?: unknown;
  }>;
  act(() => {
    root?.render(
      createElement(Provider, { locale: "en", messages: en, timeZone: "UTC" }, createElement(RecheckRequest, { passportId: PASSPORT, recheckedOn, tuck: true })),
    );
  });
  for (let turn = 0; turn < 8; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  const control = host.querySelector("[data-recheck]");
  if (!(control instanceof HTMLElement)) {
    throw new Error("the control never drew");
  }
  return control;
}

beforeEach(() => {
  clock += 60_000;
  vi.setSystemTime(clock);
  forgetCallers();
  service.status = { state: "none" };
  rpc.receipt = reportReceipt();
  rpc.blockTime = BigInt(REPORT_AT);
  // The same verdict as the registry lists it: written before the request.
  rpc.rows = [
    { receiver: addresses.simulationReceiver, matched: true, distance: 2, recomputed: `0x${"ab".repeat(32)}`, at: BigInt(REPORT_AT) },
  ];
  rpc.receipts = 0;
  rpc.attestationReads = 0;
  caller.address = "203.0.113.7";
  holds.filed = [];
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
  root = null;
  host = null;
});

afterAll(() => {
  vi.useRealTimers();
});

describe("a request the runner answered from its memory (F1)", () => {
  it("is done with the report's own date once its transaction is read, not pending for half an hour", async () => {
    queueSaysDone();
    const control = await mount(null);

    expect(control.getAttribute("data-recheck-state")).toBe("rechecked");
    expect(control.textContent).toContain(`Re-checked on ${day(REPORT_AT)}`);
    expect(control.textContent).not.toContain(en.recheck.stamp.pending);
    expect(control.textContent).not.toContain(en.recheck.button);
  });
});

describe("a report transaction the chain does not confirm", () => {
  const cases: [string, () => void][] = [
    ["sent from another wallet", () => (rpc.receipt = reportReceipt({ from: STRANGER }))],
    ["a verdict on another passport", () => (rpc.receipt = reportReceipt({ logs: [attestationLog({ passport: OTHER_PASSPORT })] }))],
    ["a transaction that reverted", () => (rpc.receipt = reportReceipt({ status: "reverted" }))],
    ["a log that did not come from the registry", () => (rpc.receipt = reportReceipt({ logs: [attestationLog({ emitter: STRANGER })] }))],
    ["a verdict from a receiver the app cannot name", () => (rpc.receipt = reportReceipt({ logs: [attestationLog({ receiver: STRANGER })] }))],
    ["a transaction the node has no receipt for", () => (rpc.receipt = null)],
  ];

  for (const [name, arrange] of cases) {
    it(`stays pending for ${name}, with no transaction linked`, async () => {
      arrange();
      queueSaysDone();
      const control = await mount(null);

      expect(control.getAttribute("data-recheck-state")).toBe("confirming");
      expect(control.textContent).toContain(en.recheck.stamp.pending);
      expect(control.innerHTML).not.toContain("/tx/");
      expect(rpc.receipts).toBe(1);
    });
  }

  it("confirms nothing for values that are not 32 bytes of hex, and reads nothing for them", async () => {
    expect(await confirmedReport("0x1234", TX)).toBeNull();
    expect(await confirmedReport(PASSPORT, "not a hash")).toBeNull();
    expect(rpc.receipts).toBe(0);
  });
});

describe("what the read hands back, and how long it keeps it", () => {
  it("hands back the block's time and the logged verdict, never the queue's", async () => {
    rpc.receipt = reportReceipt({ logs: [attestationLog({ matched: false, distance: 11 })] });
    expect(await confirmedReport(PASSPORT, TX)).toEqual({ at: REPORT_AT, matched: false, distance: 11 });
  });

  it("links the confirmed transaction on a screen that does not read the rows", async () => {
    queueSaysDone();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
      locale: string;
      messages: unknown;
      timeZone: string;
      children?: unknown;
    }>;
    act(() => {
      root?.render(createElement(Provider, { locale: "en", messages: en, timeZone: "UTC" }, createElement(RecheckRequest, { passportId: PASSPORT })));
    });
    for (let turn = 0; turn < 8; turn += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    const control = host.querySelector("[data-recheck]");
    expect(control?.getAttribute("data-recheck-state")).toBe("done");
    expect(control?.innerHTML).toContain(`/tx/${TX}`);
  });

  it("keeps a confirmed answer for a long time and a miss only briefly", async () => {
    await confirmedReport(PASSPORT, TX);
    const kept = holds.filed.find((one) => one.keyParts[0] === "moolam-recheck-report");
    expect(kept?.revalidate).toBeGreaterThanOrEqual(86_400);

    // A miss is asked about again only after a short wait, not on every call.
    rpc.receipt = reportReceipt({ from: STRANGER });
    const other = `0x${"52".repeat(32)}`;
    expect(await confirmedReport(PASSPORT, other)).toBeNull();
    expect(await confirmedReport(PASSPORT, other)).toBeNull();
    expect(rpc.receipts).toBe(2);
  });
});

describe("a request with no report transaction keeps the time rule", () => {
  it("stays pending while the newest verdict is older than the request", async () => {
    queueSaysDone(null);
    const control = await mount(null);

    expect(control.getAttribute("data-recheck-state")).toBe("confirming");
    expect(rpc.receipts).toBe(0);
    expect(rpc.attestationReads).toBe(1);
  });

  it("is done once a verdict from after the request is on chain", async () => {
    queueSaysDone(null);
    rpc.rows = [
      { receiver: addresses.simulationReceiver, matched: true, distance: 0, recomputed: `0x${"ab".repeat(32)}`, at: BigInt(REPORT_AT + 600) },
    ];
    const control = await mount(null);

    expect(control.getAttribute("data-recheck-state")).toBe("rechecked");
    expect(control.textContent).toContain(`Re-checked on ${day(REPORT_AT + 600)}`);
    expect(rpc.receipts).toBe(0);
  });
});

describe("a stranger calling the two reads in a loop (C1)", () => {
  it("reads the 61st call in a minute from one address as a failed read, and leaves other callers alone", async () => {
    for (let call = 0; call < 60; call += 1) {
      expect(await newestChainlinkRecheck(PASSPORT)).toBe(REPORT_AT);
      expect(await confirmedReport(PASSPORT, TX)).toEqual({ at: REPORT_AT, matched: true, distance: 2 });
    }
    const reads = rpc.attestationReads;
    const receipts = rpc.receipts;

    expect(await newestChainlinkRecheck(PASSPORT)).toBeUndefined();
    expect(await confirmedReport(PASSPORT, TX)).toBeUndefined();
    // Refused before the chain is asked anything.
    expect(rpc.attestationReads).toBe(reads);
    expect(rpc.receipts).toBe(receipts);

    caller.address = "198.51.100.4";
    expect(await newestChainlinkRecheck(PASSPORT)).toBe(REPORT_AT);
    expect(await confirmedReport(PASSPORT, TX)).toEqual({ at: REPORT_AT, matched: true, distance: 2 });
  });

  it("keeps a caller over the limit on pending, never done", async () => {
    for (let call = 0; call < 60; call += 1) {
      await confirmedReport(PASSPORT, TX);
    }
    queueSaysDone();
    const control = await mount(null);

    expect(control.getAttribute("data-recheck-state")).toBe("confirming");
    expect(control.textContent).not.toContain("Re-checked on");
  });
});
