// Covers the counter that bounds what the whole world may spend in a UTC day: taking up to a
// ceiling and being refused after it, a ceiling of zero closing an action outright, midnight
// wiping the counts, a slot handed back once and never below zero, a slot handed back after
// midnight not crediting the new day, and the shape, the sentence and the retry-after seconds of
// the refusal a route sends.
// The clock is injected, so no test here waits for a real midnight.
// Does NOT cover the routes calling any of this, which is test/global-limits.test.ts, and does not
// cover two processes: each one counts on its own, which is written down in the README.

import { describe, expect, it } from "vitest";
import {
  GLOBAL_LIMIT_CODE,
  GLOBAL_LIMIT_MESSAGE,
  dayLimitRefusal,
  globalDay,
  type DayAction,
} from "../src/limits/globalDay.js";

const CEILINGS: Record<DayAction, number> = { prepares: 2, generations: 1, edits: 0 };

/** A clock a test moves by hand. Returns the reader and a setter that takes an ISO instant. */
function clock(start: string): { now: () => number; set: (at: string) => void } {
  let at = Date.parse(start);
  return { now: () => at, set: (next: string) => (at = Date.parse(next)) };
}

describe("the day's budget for everyone", () => {
  it("takes up to the ceiling and refuses every caller after it", () => {
    const time = clock("2026-09-21T13:45:00Z");
    const day = globalDay(CEILINGS, time.now);

    expect(day.tryTake("prepares").ok).toBe(true);
    const second = day.tryTake("prepares");
    expect(second.ok).toBe(true);
    expect(second.use).toEqual({ used: 2, max: 2, resetsAt: Date.UTC(2026, 8, 22) / 1000 });

    const refused = day.tryTake("prepares");
    expect(refused.ok).toBe(false);
    expect(refused.use.used).toBe(2);
    expect(day.counts().prepares).toEqual({ used: 2, max: 2 });
  });

  it("counts each action on its own", () => {
    const time = clock("2026-09-21T13:45:00Z");
    const day = globalDay(CEILINGS, time.now);

    expect(day.tryTake("prepares").ok).toBe(true);

    expect(day.counts()).toEqual({
      prepares: { used: 1, max: 2 },
      generations: { used: 0, max: 1 },
      edits: { used: 0, max: 0 },
    });
  });

  it("closes an action whose ceiling is zero, which is the kill switch", () => {
    const time = clock("2026-09-21T13:45:00Z");
    const day = globalDay(CEILINGS, time.now);

    const refused = day.tryTake("edits");

    expect(refused.ok).toBe(false);
    expect(refused.use).toEqual({ used: 0, max: 0, resetsAt: Date.UTC(2026, 8, 22) / 1000 });
    // A refusal has no slot to hand back, so asking cannot leave the count below zero.
    refused.giveBack();
    expect(day.counts().edits).toEqual({ used: 0, max: 0 });
  });

  it("goes back to zero at midnight UTC and not a second before", () => {
    const time = clock("2026-09-21T23:59:59Z");
    const day = globalDay(CEILINGS, time.now);

    expect(day.tryTake("generations").ok).toBe(true);
    expect(day.tryTake("generations").ok).toBe(false);

    time.set("2026-09-21T23:59:59.999Z");
    expect(day.tryTake("generations").ok).toBe(false);

    time.set("2026-09-22T00:00:00Z");
    const fresh = day.tryTake("generations");
    expect(fresh.ok).toBe(true);
    expect(fresh.use.resetsAt).toBe(Date.UTC(2026, 8, 23) / 1000);
    expect(day.counts().generations).toEqual({ used: 1, max: 1 });
  });

  it("hands a slot back once, however many times it is asked", () => {
    const time = clock("2026-09-21T13:45:00Z");
    const day = globalDay(CEILINGS, time.now);

    const taken = day.tryTake("prepares");
    expect(day.counts().prepares.used).toBe(1);

    taken.giveBack();
    taken.giveBack();
    taken.giveBack();

    expect(day.counts().prepares.used).toBe(0);
    // The ceiling is whole again, which a count pushed below zero would have made three.
    expect(day.tryTake("prepares").ok).toBe(true);
    expect(day.tryTake("prepares").ok).toBe(true);
    expect(day.tryTake("prepares").ok).toBe(false);
  });

  it("does not credit the new day with a slot taken yesterday", () => {
    const time = clock("2026-09-21T23:59:00Z");
    const day = globalDay(CEILINGS, time.now);

    const taken = day.tryTake("prepares");
    time.set("2026-09-22T00:01:00Z");
    taken.giveBack();

    expect(day.counts().prepares).toEqual({ used: 0, max: 2 });
    expect(day.tryTake("prepares").ok).toBe(true);
    expect(day.tryTake("prepares").ok).toBe(true);
    expect(day.tryTake("prepares").ok).toBe(false);
  });

  it("reports the counts as of now, so a probe after midnight never reads yesterday", () => {
    const time = clock("2026-09-21T10:00:00Z");
    const day = globalDay(CEILINGS, time.now);

    day.tryTake("prepares");
    time.set("2026-09-22T10:00:00Z");

    expect(day.counts().prepares).toEqual({ used: 0, max: 2 });
  });
});

describe("the refusal a route sends", () => {
  it("carries the keys the per-user refusal uses, the sentence and the seconds until midnight", () => {
    const at = Date.parse("2026-09-21T21:00:00Z");
    const use = { used: 300, max: 300, resetsAt: Date.UTC(2026, 8, 22) / 1000 };

    const refusal = dayLimitRefusal(use, at);

    expect(refusal.body).toEqual({
      error: GLOBAL_LIMIT_CODE,
      reason: GLOBAL_LIMIT_MESSAGE,
      quota: { used: 300, limit: 300, resetsAt: Date.UTC(2026, 8, 22) / 1000 },
    });
    expect(refusal.body.error).toBe("global-limit");
    expect(refusal.body.reason).toContain("midnight UTC");
    expect(refusal.retryAfter).toBe(3 * 60 * 60);
  });

  it("never tells a caller to come back in no time at all", () => {
    const use = { used: 1, max: 1, resetsAt: Date.UTC(2026, 8, 22) / 1000 };

    expect(dayLimitRefusal(use, Date.UTC(2026, 8, 22)).retryAfter).toBe(1);
    expect(dayLimitRefusal(use, Date.UTC(2026, 8, 23)).retryAfter).toBe(1);
  });
});
