import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLAIM_WATCH_MS,
  POLL_MS,
  waitsForClaim,
  watchForClaim,
  type WatchClock,
  type WatchPage,
} from "@/components/result/result-screen";

const MINUTE = 60_000;
const TO = "a***@example.com";

/** Real timers, driven by vitest's fake clock, so the cadence under test is the one the browser would run. */
const clock: WatchClock = {
  set: (run, ms) => setInterval(run, ms),
  clear: (timer) => clearInterval(timer as ReturnType<typeof setInterval>),
  now: () => Date.now(),
};

function fakePage() {
  const listeners = new Set<() => void>();
  const page: WatchPage & { visibilityState: string; show: (state: string) => void; count: () => number } = {
    visibilityState: "visible",
    addEventListener: (_type, listener) => void listeners.add(listener),
    removeEventListener: (_type, listener) => void listeners.delete(listener),
    show(state) {
      page.visibilityState = state;
      for (const listener of [...listeners]) listener();
    },
    count: () => listeners.size,
  };
  return page;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("which pictures the result screen watches for a claim", () => {
  it("watches a registered picture whose delivery is waiting, and nothing else", () => {
    expect(waitsForClaim({ state: "registered", delivery: { kind: "waiting", to: TO } })).toBe(true);
    expect(waitsForClaim({ state: "registered", delivery: { kind: "straight", to: TO } })).toBe(false);
    expect(waitsForClaim({ state: "registered" })).toBe(false);
    expect(waitsForClaim({ state: "moved", delivery: { kind: "waiting", to: TO } })).toBe(false);
    expect(waitsForClaim({ state: "cosign-open", delivery: { kind: "waiting", to: TO } })).toBe(false);
    expect(waitsForClaim({ state: "woven" })).toBe(false);
    expect(waitsForClaim({ state: "failed" })).toBe(false);
  });
});

describe("the claim watch", () => {
  it("reads on the same 5 second beat the co-sign wait uses", () => {
    expect(POLL_MS).toBe(5_000);
    const read = vi.fn();
    watchForClaim(read, clock, fakePage());
    vi.advanceTimersByTime(POLL_MS - 1);
    expect(read).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(read).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(POLL_MS * 4);
    expect(read).toHaveBeenCalledTimes(5);
  });

  it("stops reading after 15 minutes and stays stopped", () => {
    expect(CLAIM_WATCH_MS).toBe(15 * MINUTE);
    const read = vi.fn();
    watchForClaim(read, clock, fakePage());
    vi.advanceTimersByTime(15 * MINUTE - POLL_MS);
    expect(read).toHaveBeenCalledTimes(179);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(POLL_MS);
    expect(read).toHaveBeenCalledTimes(180);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60 * MINUTE);
    expect(read).toHaveBeenCalledTimes(180);
  });

  it("counts the 15 minutes from when the watch began, not from the page opening", () => {
    const read = vi.fn();
    vi.advanceTimersByTime(40 * MINUTE);
    watchForClaim(read, clock, fakePage());
    vi.advanceTimersByTime(15 * MINUTE);
    expect(read).toHaveBeenCalledTimes(180);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("re-reads once when the page becomes visible again, and not when it is hidden", () => {
    const read = vi.fn();
    const page = fakePage();
    watchForClaim(read, clock, page);
    page.show("hidden");
    expect(read).not.toHaveBeenCalled();
    page.show("visible");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("still re-reads once on return after the timed watch has ended", () => {
    const read = vi.fn();
    const page = fakePage();
    watchForClaim(read, clock, page);
    vi.advanceTimersByTime(20 * MINUTE);
    expect(read).toHaveBeenCalledTimes(180);
    page.show("visible");
    expect(read).toHaveBeenCalledTimes(181);
  });

  it("removes its listener and its timer when the screen goes away", () => {
    const read = vi.fn();
    const page = fakePage();
    const stop = watchForClaim(read, clock, page);
    expect(page.count()).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    stop();
    expect(page.count()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    page.show("visible");
    vi.advanceTimersByTime(20 * MINUTE);
    expect(read).not.toHaveBeenCalled();
  });
});

describe("the result screen wiring", () => {
  const source = readFileSync(path.resolve(__dirname, "../components/result/result-screen.tsx"), "utf8");

  it("starts the claim watch only while the loaded picture waits for a claim", () => {
    expect(source).toContain('const claimPending = load.kind === "ready" && waitsForClaim(load.picture);');
    expect(source).toContain("if (!claimPending) return;");
    expect(source).toContain("return watchForClaim(() => void refresh(), BROWSER_CLOCK, document);");
    expect(source).toContain("[claimPending, refresh]");
  });

  it("leaves Moolam's co-sign window open when the store says registered", () => {
    expect(source).not.toMatch(/LANDED\.has\(state\)\)\s*checkout\.close\(\)/);
    const closes = source.match(/checkout\.close\(\)/g) ?? [];
    expect(closes).toHaveLength(1);
    expect(source).toMatch(/const cancelSign = useCallback\(\(\) => \{\s*checkout\.close\(\);/);
    expect(source).toContain("can cut off the person's second transaction, the AI-use terms.");
  });

  it("keeps the move block's email flag line as it was", () => {
    expect(source).toContain('const waitsByEmail = picture.state === "registered" && picture.delivery?.kind === "waiting";');
  });
});
