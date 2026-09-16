/**
 * How much scene this machine can carry, decided from its own frame times.
 *
 * The tier used to be picked once from the screen width, so a desktop-width
 * laptop with a weak GPU kept the full field and stuttered through the whole
 * flight. This watches the frames as they go past instead: when they run long
 * for two seconds the field drops a tier, and a machine that still cannot hold
 * the lowest tier is handed the still story.
 *
 * Nothing here touches the DOM, three or React, so every rule below is tested
 * in test/story-tier.test.ts against a made-up stream of frame times.
 */

export interface TierLevel {
  plates: number;
  particles: number;
  /** The top of the canvas pixel ratio range. The floor is always 1. */
  dpr: number;
  /** The last tier has no canvas at all: the still story takes over. */
  still: boolean;
}

export const TIERS: readonly TierLevel[] = [
  { plates: 40, particles: 220, dpr: 1.75, still: false },
  { plates: 28, particles: 150, dpr: 1.3, still: false },
  { plates: 20, particles: 110, dpr: 1, still: false },
  { plates: 0, particles: 0, dpr: 1, still: true },
];

export const STILL_TIER = TIERS.length - 1;

/** Frame times are averaged over this much of the recent past. */
export const WINDOW_MS = 2000;
/** Nothing is measured while the textures are still arriving. */
export const GRACE_MS = 2000;
/** Above this mean the field is costing more than the machine has. */
export const SLOW_MS = 22;
/** Below this mean there is room for more field than is on screen. */
export const FAST_MS = 11;
export const SLOW_FOR_MS = 2000;
export const FAST_FOR_MS = 10000;
/**
 * How much of the frame time a step down has to buy back to have been worth
 * making. Measured on a laptop with no GPU: the software renderer paces every
 * frame at about 33 ms whatever is on screen, so the field shrank three times
 * for a mean that never moved (20.7, then 20.4, then 20.9) and the reader lost
 * the film for nothing. A step that does not clear this bar is undone.
 */
export const GAIN = 0.9;
/**
 * The mean above which a machine is not being slowed by the field at all, it
 * simply cannot draw this film: under thirty frames a second with the smaller
 * field already in front of it. That one gets the still story rather than
 * another plate shaved off a picture it was never going to hold.
 */
export const STILL_MS = 32;
/** After a step the new field gets this long to settle before it is judged. */
export const SETTLE_MS = 3000;
/** A step back the other way is only allowed this long after the last step. */
export const REVERSE_MS = 60000;

/**
 * A frame longer than this is a pause, not a frame rate: a background tab, a
 * blocked main thread, an alt-tab. Counting those would drop the field for
 * something the field did not cause.
 */
const STALL_MS = 250;

/** The mean needs this many frames behind it before it decides anything. */
const ENOUGH = 8;

export interface FrameSample {
  at: number;
  ms: number;
}

export interface TierState {
  readonly tier: number;
  /** The best tier this device may climb to. A phone never gets the desktop field. */
  readonly ceiling: number;
  readonly samples: readonly FrameSample[];
  /** When the mean first went slow, or fast, and stayed there. */
  readonly slowSince: number | null;
  readonly fastSince: number | null;
  /** Nothing is judged before this time, so a fresh field is not measured mid-swap. */
  readonly settledAt: number;
  readonly steppedAt: number;
  /** Which way the last step went, so the opposite one can be held back. */
  readonly steppedDown: boolean | null;
  /** The mean that caused the last step down, kept until that step can be judged. */
  readonly meanAtStep: number | null;
  /** Set once a step down has been shown not to help. The field stops shrinking. */
  readonly stopShrinking: boolean;
}

/** Phones start one tier down: a narrow window on the same field costs the same frame on a smaller GPU. */
export function startTier(width: number): number {
  return width < 768 ? 1 : 0;
}

export function createTierState(start: number): TierState {
  return {
    tier: start,
    ceiling: start,
    samples: [],
    slowSince: null,
    fastSince: null,
    settledAt: 0,
    steppedAt: 0,
    steppedDown: null,
    meanAtStep: null,
    stopShrinking: false,
  };
}

export function tierLevel(tier: number): TierLevel {
  return TIERS[Math.min(Math.max(tier, 0), STILL_TIER)];
}

/**
 * One frame's worth of evidence.
 *
 * `nowMs` is milliseconds since the scene started, not wall clock, so the mount
 * grace period and every hold below are measured from the same zero the caller
 * already has in its render loop.
 */
export function nextTier(state: TierState, deltaMs: number, nowMs: number): TierState {
  if (nowMs < GRACE_MS || state.tier >= STILL_TIER) {
    return state;
  }

  const samples: FrameSample[] = [];
  for (const sample of state.samples) {
    if (nowMs - sample.at <= WINDOW_MS) {
      samples.push(sample);
    }
  }
  if (deltaMs > 0 && deltaMs <= STALL_MS) {
    samples.push({ at: nowMs, ms: deltaMs });
  }

  if (nowMs < state.settledAt || samples.length < ENOUGH) {
    return { ...state, samples, slowSince: null, fastSince: null };
  }

  let total = 0;
  for (const sample of samples) {
    total += sample.ms;
  }
  const mean = total / samples.length;

  const slowSince = mean > SLOW_MS ? (state.slowSince ?? nowMs) : null;
  const fastSince = mean < FAST_MS ? (state.fastSince ?? nowMs) : null;
  const measuring: TierState = { ...state, samples, slowSince, fastSince };

  // The first honest look at the field that the last step down produced. If the
  // frames are no better than they were before it, the field was never what was
  // costing the time, so the plates come back and nothing is taken away again.
  if (state.meanAtStep !== null) {
    if (mean > state.meanAtStep * GAIN) {
      // Still under thirty frames a second with less on screen: the field was
      // never the weight. Hand over the still story rather than shave the
      // picture again for nothing.
      if (mean > STILL_MS) {
        return { ...step(measuring, STILL_TIER, nowMs, true), meanAtStep: null, stopShrinking: true };
      }
      return { ...step(measuring, state.tier - 1, nowMs, false), meanAtStep: null, stopShrinking: true };
    }
    return { ...measuring, meanAtStep: null };
  }

  if (!state.stopShrinking && slowSince !== null && nowMs - slowSince >= SLOW_FOR_MS && turnAllowed(state, true, nowMs)) {
    return { ...step(measuring, state.tier + 1, nowMs, true), meanAtStep: mean };
  }
  if (
    fastSince !== null &&
    nowMs - fastSince >= FAST_FOR_MS &&
    state.tier > state.ceiling &&
    turnAllowed(state, false, nowMs)
  ) {
    return step(measuring, state.tier - 1, nowMs, false);
  }

  return measuring;
}

/** A machine sitting on the line would otherwise swap the field in and out under the reader. */
function turnAllowed(state: TierState, down: boolean, nowMs: number): boolean {
  return state.steppedDown === null || state.steppedDown === down || nowMs - state.steppedAt >= REVERSE_MS;
}

function step(state: TierState, tier: number, nowMs: number, down: boolean): TierState {
  return {
    ...state,
    tier,
    // The frame times just taken belong to the field that is being replaced.
    samples: [],
    slowSince: null,
    fastSince: null,
    settledAt: nowMs + SETTLE_MS,
    steppedAt: nowMs,
    steppedDown: down,
  };
}
