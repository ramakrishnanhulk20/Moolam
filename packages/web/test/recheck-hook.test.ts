// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode, act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Hex } from "viem";
import { POLL_LIMIT, POLL_MS, type RecheckState } from "@/lib/recheck/state";
import type { RecheckControl } from "@/lib/recheck/useRecheck";

/**
 * The control's own behaviour: what it asks, when it asks it, and what it stops
 * asking.
 *
 * The verify service is one small host shared by the live site, the index and
 * every open tab, so the rules that matter here are the quiet ones. One read on
 * arrival. One a minute while something is really in flight. None at all while
 * the tab is in the background. Thirty of them and then it holds still and
 * waits to be pressed.
 */

const PASSPORT = `0x${"7c".repeat(32)}` as Hex;
const TX = `0x${"91".repeat(32)}` as Hex;

const service = vi.hoisted(() => ({
  lookups: [] as unknown[],
  requests: [] as unknown[],
  reads: 0,
  posts: 0,
  nextLookup: { state: "none" } as unknown,
  nextRequest: undefined as unknown,
  throwOnRequest: undefined as unknown,
}));

vi.mock("@/lib/verifier/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/verifier/client")>()),
  readRecheckStatus: async (id: Hex) => {
    service.reads += 1;
    service.lookups.push(id);
    return service.nextLookup;
  },
  requestRecheck: async (id: Hex) => {
    service.posts += 1;
    service.requests.push(id);
    if (service.throwOnRequest !== undefined) {
      throw service.throwOnRequest;
    }
    return service.nextRequest;
  },
}));

const { VerifierError } = await import("@/lib/verifier/client");
const { useRecheckRequest } = await import("@/lib/recheck/useRecheck");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let shown: "visible" | "hidden" = "visible";
const held = { control: null as RecheckControl | null, done: 0 };

function Probe(): null {
  const control = useRecheckRequest({
    passportId: PASSPORT,
    onDone: () => {
      held.done += 1;
    },
  });
  // Handed out after the draw rather than during it, which is the only moment
  // a test is allowed to reach into a component from outside.
  useEffect(() => {
    held.control = control;
  });
  return null;
}

function control(): RecheckControl {
  if (held.control === null) {
    throw new Error("the control never rendered");
  }
  return held.control;
}

function state(): RecheckState {
  return control().state;
}

let root: Root | null = null;

function mount(): void {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(createElement(Probe));
  });
}

/** Lets every promise the control is holding settle, and React draw what came back. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** A minute of the reader's time, with React given its turn after it. */
async function minutes(count: number): Promise<void> {
  for (let at = 0; at < count; at += 1) {
    act(() => {
      vi.advanceTimersByTime(POLL_MS);
    });
    await flush();
  }
}

function look(at: "visible" | "hidden"): void {
  shown = at;
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

beforeEach(() => {
  service.lookups = [];
  service.requests = [];
  service.reads = 0;
  service.posts = 0;
  service.nextLookup = { state: "none" };
  service.nextRequest = undefined;
  service.throwOnRequest = undefined;
  held.control = null;
  held.done = 0;
  shown = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => shown });
  vi.useFakeTimers();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  vi.useRealTimers();
});

describe("what the control asks when it arrives", () => {
  it("reads the status once and offers the button when nobody has asked", async () => {
    mount();
    await flush();

    expect(service.reads).toBe(1);
    expect(service.lookups[0]).toBe(PASSPORT);
    expect(state().kind).toBe("none");
    expect(control().spent).toBe(false);
  });

  it("shows a request somebody else already made", async () => {
    service.nextLookup = { state: "known", status: { status: "pending", requestedAt: 1_790_000_000_000 } };
    mount();
    await flush();

    expect(state()).toEqual({ kind: "queued", requestedAt: 1_790_000_000_000, already: false });
  });

  it("shows a re-check that is running now", async () => {
    service.nextLookup = {
      state: "known",
      status: { status: "running", requestedAt: 1_790_000_000_000, startedAt: 1_790_000_060_000 },
    };
    mount();
    await flush();

    expect(state().kind).toBe("running");
  });

  it("still gets its answer when React mounts the control twice, as it does in development", async () => {
    service.nextLookup = { state: "known", status: { status: "pending", requestedAt: 1_790_000_000_000 } };

    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => {
      root?.render(createElement(StrictMode, null, createElement(Probe)));
    });
    await flush();

    // The first read is cut short by the extra unmount, so the one that counts
    // is the second. What must never happen is both being dropped and the
    // control sitting on its starting state with a request really in the queue.
    expect(state().kind).toBe("queued");
  });

  it("changes nothing when the service could not say", async () => {
    service.nextLookup = { state: "unknown", reason: "the verify service did not answer" };
    mount();
    await flush();

    // The button is still there, and no failure is drawn out of silence.
    expect(state().kind).toBe("none");
  });
});

describe("what one press does", () => {
  it("sends the request and shows the place in the queue", async () => {
    mount();
    await flush();

    service.nextRequest = {
      passportId: PASSPORT,
      status: "pending",
      requestedAt: 1_790_000_000_000,
      position: 4,
      already: false,
    };
    act(() => control().actions.request());
    expect(state().kind).toBe("sending");
    await flush();

    expect(service.posts).toBe(1);
    expect(state()).toEqual({ kind: "queued", requestedAt: 1_790_000_000_000, position: 4, already: false });
  });

  it("says a passport was already asked about rather than treating it as a refusal", async () => {
    mount();
    await flush();

    service.nextRequest = {
      passportId: PASSPORT,
      status: "pending",
      requestedAt: 1_790_000_000_000,
      position: 2,
      already: true,
    };
    act(() => control().actions.request());
    await flush();

    const now = state();
    expect(now.kind).toBe("queued");
    if (now.kind === "queued") {
      expect(now.already).toBe(true);
      expect(now.position).toBe(2);
    }
  });

  it("drops a position of zero rather than printing a place nobody holds", async () => {
    mount();
    await flush();

    service.nextRequest = {
      passportId: PASSPORT,
      status: "pending",
      requestedAt: 1_790_000_000_000,
      position: 0,
      already: true,
    };
    act(() => control().actions.request());
    await flush();

    const now = state();
    expect(now.kind === "queued" && now.position).toBe(undefined);
  });

  it("sends nothing twice while one request is still out", async () => {
    mount();
    await flush();

    service.nextRequest = { passportId: PASSPORT, status: "pending", requestedAt: 1_790_000_000_000, position: 1 };
    act(() => {
      control().actions.request();
      control().actions.request();
    });
    await flush();

    expect(service.posts).toBe(1);
  });
});

describe("the two ways a request ends", () => {
  it("shows the verdict and asks the page to read itself again, exactly once", async () => {
    service.nextLookup = { state: "known", status: { status: "pending", requestedAt: 1_790_000_000_000 } };
    mount();
    await flush();

    service.nextLookup = {
      state: "known",
      status: { status: "done", requestedAt: 1_790_000_000_000, finishedAt: 1_790_000_300_000, reportTx: TX, matched: true, distance: 0 },
    };
    await minutes(1);

    const now = state();
    expect(now.kind).toBe("done");
    if (now.kind === "done") {
      expect(now.reportTx).toBe(TX);
      expect(now.matched).toBe(true);
    }
    expect(held.done).toBe(1);

    // The page is asked once, however many times the control is pressed after.
    act(() => control().actions.check());
    await flush();
    expect(held.done).toBe(1);
  });

  it("says a run could not finish in the runner's own words, and lets the reader ask again", async () => {
    service.nextLookup = {
      state: "known",
      status: { status: "failed", requestedAt: 1_790_000_000_000, reason: "the picture could not be fetched from IPFS" },
    };
    mount();
    await flush();

    const now = state();
    expect(now.kind).toBe("failed");
    if (now.kind === "failed") {
      expect(now.reason).toContain("IPFS");
    }
    expect(held.done).toBe(0);

    service.nextRequest = { passportId: PASSPORT, status: "pending", requestedAt: 1_790_000_600_000, position: 1 };
    act(() => control().actions.request());
    await flush();
    expect(service.posts).toBe(1);
    expect(state().kind).toBe("queued");
  });
});

describe("the refusals a press can meet", () => {
  const cases: [string, unknown, string, boolean][] = [
    ["a passport the service does not know", new VerifierError("bad-response", 404, "no-passport", undefined, { named: true, serviceCode: "no-passport" }), "noPassport", false],
    ["a sealed passport", new VerifierError("bad-response", 409, "sealed", undefined, { named: true, serviceCode: "sealed" }), "sealed", false],
    ["a queue with no room left", new VerifierError("bad-response", 503, "queue-full", undefined, { named: true, serviceCode: "queue-full" }), "queueFull", true],
    ["too many presses from one place", new VerifierError("rate-limited", 429, "too many requests"), "rateLimited", true],
    ["a service that is not answering", new VerifierError("offline", 0, "the verify service did not answer"), "notAnswering", true],
  ];

  for (const [name, thrown, key, canRetry] of cases) {
    it(`says its own sentence for ${name}`, async () => {
      mount();
      await flush();

      service.throwOnRequest = thrown;
      act(() => control().actions.request());
      await flush();

      const now = state();
      expect(now.kind).toBe("refused");
      if (now.kind === "refused") {
        expect(now.key).toBe(key);
        expect(now.canRetry).toBe(canRetry);
      }
    });
  }
});

describe("how often it asks", () => {
  it("asks once a minute while a request is in flight", async () => {
    service.nextLookup = { state: "known", status: { status: "pending", requestedAt: 1_790_000_000_000 } };
    mount();
    await flush();
    expect(service.reads).toBe(1);

    await minutes(3);
    expect(service.reads).toBe(4);
  });

  it("asks nothing once the answer has arrived", async () => {
    service.nextLookup = {
      state: "known",
      status: { status: "done", requestedAt: 1_790_000_000_000, finishedAt: 1_790_000_300_000, reportTx: TX },
    };
    mount();
    await flush();

    await minutes(5);
    expect(service.reads).toBe(1);
  });

  it("stops after half an hour and hands the reader the button", async () => {
    service.nextLookup = { state: "known", status: { status: "pending", requestedAt: 1_790_000_000_000 } };
    mount();
    await flush();

    await minutes(POLL_LIMIT + 5);
    expect(service.reads).toBe(POLL_LIMIT + 1);
    expect(control().spent).toBe(true);

    // The reader's own press works after that, and starts the clock again.
    act(() => control().actions.check());
    await flush();
    expect(service.reads).toBe(POLL_LIMIT + 2);
    expect(control().spent).toBe(false);
  });

  it("asks nothing at all while the tab is in the background", async () => {
    service.nextLookup = { state: "known", status: { status: "pending", requestedAt: 1_790_000_000_000 } };
    mount();
    await flush();
    expect(service.reads).toBe(1);

    look("hidden");
    await minutes(5);
    expect(service.reads).toBe(1);

    look("visible");
    await minutes(1);
    expect(service.reads).toBe(2);
  });
});
