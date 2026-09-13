import { describe, expect, it } from "vitest";
import {
  FAST_FOR_MS,
  GRACE_MS,
  REVERSE_MS,
  SETTLE_MS,
  SLOW_FOR_MS,
  STILL_TIER,
  TIERS,
  createTierState,
  nextTier,
  startTier,
  tierLevel,
  type TierState,
} from "@/components/story/tier";

interface Run {
  state: TierState;
  /** When the tier first changed during this run, in ms since the scene started. */
  changedAt: number | null;
  now: number;
}

/** Plays a stream of frames at `frame(index)` milliseconds each and watches the tier. */
function play(state: TierState, forMs: number, frame: (index: number) => number, startMs = 0): Run {
  let now = startMs;
  let current = state;
  let changedAt: number | null = null;
  const end = startMs + forMs;

  for (let index = 0; now < end; index += 1) {
    const ms = frame(index);
    now += ms;
    const before = current.tier;
    current = nextTier(current, ms, now);
    if (current.tier !== before && changedAt === null) {
      changedAt = now;
    }
  }

  return { state: current, changedAt, now };
}

const steady = (ms: number) => () => ms;

describe("the tier table", () => {
  it("runs from the full field down to the still story", () => {
    expect(TIERS.map((level) => level.plates)).toEqual([40, 28, 20, 0]);
    expect(TIERS.map((level) => level.particles)).toEqual([220, 150, 110, 0]);
    expect(TIERS.map((level) => level.dpr)).toEqual([1.75, 1.3, 1, 1]);
    expect(TIERS[STILL_TIER].still).toBe(true);
    expect(tierLevel(9)).toBe(TIERS[STILL_TIER]);
  });

  it("starts a phone one tier down and a desktop at the top", () => {
    expect(startTier(390)).toBe(1);
    expect(startTier(767)).toBe(1);
    expect(startTier(768)).toBe(0);
    expect(startTier(1440)).toBe(0);
  });
});

describe("stepping down", () => {
  it("drops a tier after two seconds of thirty millisecond frames, then holds three", () => {
    const first = play(createTierState(0), GRACE_MS + SLOW_FOR_MS, steady(30));
    expect(first.state.tier).toBe(0);

    const dropped = play(first.state, 2000, steady(30), first.now);
    expect(dropped.state.tier).toBe(1);
    expect(dropped.changedAt).not.toBeNull();

    const stepAt = dropped.changedAt as number;
    // Two seconds of slow frames, plus the few it takes to fill the window.
    expect(stepAt).toBeGreaterThan(GRACE_MS + SLOW_FOR_MS);
    expect(stepAt).toBeLessThan(GRACE_MS + SLOW_FOR_MS + 500);

    const holding = play(dropped.state, SETTLE_MS - 100, steady(30), stepAt);
    expect(holding.state.tier).toBe(1);

    const after = play(holding.state, SLOW_FOR_MS + 500, steady(30), holding.now);
    expect(after.state.tier).toBe(2);
  });

  it("ignores the first two seconds while the textures are loading", () => {
    const grace = play(createTierState(0), GRACE_MS, steady(60));
    expect(grace.state.tier).toBe(0);
    expect(grace.state.samples.every((sample) => sample.at >= GRACE_MS)).toBe(true);
  });

  it("hands a machine that cannot hold the lowest tier the still story", () => {
    const ended = play(createTierState(0), 60000, steady(40));
    expect(ended.state.tier).toBe(STILL_TIER);
    expect(tierLevel(ended.state.tier).still).toBe(true);
  });
});

describe("stepping up", () => {
  it("climbs a tier after ten seconds of eight millisecond frames", () => {
    const slowed: TierState = { ...createTierState(0), tier: 1 };

    const waiting = play(slowed, GRACE_MS + FAST_FOR_MS, steady(8));
    expect(waiting.state.tier).toBe(1);

    const climbed = play(waiting.state, 2000, steady(8), waiting.now);
    expect(climbed.state.tier).toBe(0);
  });

  it("never climbs past the tier this screen started on", () => {
    const phone = play(createTierState(1), 120000, steady(8));
    expect(phone.state.tier).toBe(1);
  });

  it("waits a minute before turning back the other way", () => {
    const dropped = play(createTierState(0), GRACE_MS + SLOW_FOR_MS + 1000, steady(30));
    expect(dropped.state.tier).toBe(1);

    const early = play(dropped.state, REVERSE_MS - SETTLE_MS - 2000, steady(8), dropped.now);
    expect(early.state.tier).toBe(1);

    const late = play(early.state, 30000, steady(8), early.now);
    expect(late.state.tier).toBe(0);
    expect((late.changedAt as number) - (dropped.changedAt as number)).toBeGreaterThanOrEqual(REVERSE_MS);
  });
});

describe("a machine sitting on the line", () => {
  it("does not flap when the frames jitter around the limit", () => {
    const jitter = [18, 26, 20, 24, 19, 25];
    const minute = play(createTierState(0), 60000, (index) => jitter[index % jitter.length]);
    expect(minute.state.tier).toBe(0);
    expect(minute.changedAt).toBeNull();
  });

  it("does not count a stall from a background tab as a slow frame", () => {
    const paused = play(createTierState(0), 60000, (index) => (index % 2 === 0 ? 900 : 10));
    expect(paused.state.tier).toBe(0);
  });
});
