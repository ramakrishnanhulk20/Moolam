/** Unix time ignores leap seconds, so every UTC day is exactly this many milliseconds long. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** The three things a caller can make this service spend: pins, model calls and sponsored gas. */
export type DayAction = "prepares" | "generations" | "edits";

export const DAY_ACTIONS: readonly DayAction[] = ["prepares", "generations", "edits"];

/** What the code the studio does not know reads as: a 429 it already treats as "try later". */
export const GLOBAL_LIMIT_CODE = "global-limit";

export const GLOBAL_LIMIT_MESSAGE =
  "Moolam has reached today's limit for this action for everyone. It opens again at midnight UTC.";

export interface DayUse {
  used: number;
  /** The day's ceiling for everyone. Zero closes the action, which is the kill switch. */
  max: number;
  /** Unix seconds at the next midnight UTC, when every count goes back to zero. */
  resetsAt: number;
}

export interface DayTake {
  ok: boolean;
  use: DayUse;
  /**
   * Hands the slot back, at most once, and never across midnight.
   *
   * A refused take has nothing to hand back, so calling this on one does nothing.
   */
  giveBack: () => void;
}

export interface GlobalDay {
  tryTake: (action: DayAction) => DayTake;
  /** What /health reports: how much of each day's budget the whole world has used. */
  counts: () => Record<DayAction, { used: number; max: number }>;
}

/**
 * How much of today's budget the whole world has spent, per action.
 *
 * Every other limit in this service is per Privy user id, and accounts are free, so nothing bounds
 * what a hundred throwaway accounts can cost in a day. This is that bound: one count per action
 * per UTC day, shared by everyone, checked after the caller's token and their own quota have
 * passed and before a cent of Pinata, OpenAI or sponsored gas is spent.
 *
 * The counts live in this process's memory, exactly like the per-user quotas, so a redeploy resets
 * them and two copies of the service would count separately. The real bound on sponsored gas is
 * the daily cap in the Privy dashboard, which no code here can enforce.
 *
 * Nothing in here awaits, so a check and the increment that follows it cannot be interleaved by a
 * second request, and one request can only take a slot at the single place its route calls this.
 *
 * The clock is a parameter so a test can walk it over midnight without waiting for one.
 */
export function globalDay(max: Record<DayAction, number>, now: () => number = Date.now): GlobalDay {
  const used: Record<DayAction, number> = { prepares: 0, generations: 0, edits: 0 };
  let day = Math.floor(now() / DAY_MS);

  const currentDay = (): number => {
    const today = Math.floor(now() / DAY_MS);
    if (today !== day) {
      day = today;
      used.prepares = 0;
      used.generations = 0;
      used.edits = 0;
    }
    return today;
  };

  const describe = (action: DayAction, today: number): DayUse => ({
    used: used[action],
    max: max[action],
    resetsAt: (today + 1) * (DAY_MS / 1000),
  });

  return {
    tryTake(action: DayAction): DayTake {
      const today = currentDay();
      if (used[action] >= max[action]) {
        return { ok: false, use: describe(action, today), giveBack: () => undefined };
      }

      used[action] += 1;
      let held = true;
      return {
        ok: true,
        use: describe(action, today),
        giveBack: () => {
          if (!held) return;
          held = false;
          // Midnight already wiped this slot. Subtracting now would push the count below what
          // today's callers have actually spent and hand the world a few free ones.
          if (currentDay() !== today) return;
          used[action] = Math.max(0, used[action] - 1);
        },
      };
    },

    counts(): Record<DayAction, { used: number; max: number }> {
      // Asked for the side effect: a probe read after midnight must not report yesterday's counts.
      currentDay();
      return {
        prepares: { used: used.prepares, max: max.prepares },
        generations: { used: used.generations, max: max.generations },
        edits: { used: used.edits, max: max.edits },
      };
    },
  };
}

/**
 * The 429 a caller gets when the day's budget for everyone is gone.
 *
 * `error` and `quota` are the keys the per-user refusal already uses, so the studio reads this
 * without a change: `global-limit` is not a code it knows, so it falls back to the status, and a
 * 429 it already shows as "try later" with the sentence from `reason` underneath.
 */
export function dayLimitRefusal(
  use: DayUse,
  atMs: number = Date.now(),
): {
  body: { error: string; reason: string; quota: { used: number; limit: number; resetsAt: number } };
  retryAfter: number;
} {
  return {
    body: {
      error: GLOBAL_LIMIT_CODE,
      reason: GLOBAL_LIMIT_MESSAGE,
      quota: { used: use.used, limit: use.max, resetsAt: use.resetsAt },
    },
    // Never zero: a caller told to retry in no time at all would come straight back.
    retryAfter: Math.max(1, use.resetsAt - Math.floor(atMs / 1000)),
  };
}
