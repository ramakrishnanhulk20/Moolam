import { readFileSync } from "node:fs";
import { z } from "zod";
import { safeReason } from "../net/errorText.js";
import { STATE_FILES, stateFile, writeJsonFile } from "../stateDir.js";

/** Unix time ignores leap seconds, so every UTC day is exactly this many milliseconds long. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The things a caller can make this service spend: pins, model calls and sponsored gas, and the
 * read links /sealed/link mints to private copies, which spend nothing but exposure.
 */
export type DayAction = "prepares" | "generations" | "edits" | "unseals" | "links";

export const DAY_ACTIONS: readonly DayAction[] = ["prepares", "generations", "edits", "unseals", "links"];

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

/** One UTC day's counts as they are kept on disk: the day number since the epoch and each count. */
export interface DayRecord {
  day: number;
  used: Record<DayAction, number>;
}

/**
 * What a store found at boot. "refused" is a file that exists and cannot be believed: unreadable,
 * not JSON, not this shape, or stamped with a day that has not come yet.
 */
export type StoredDay =
  | { kind: "none"; note?: string }
  | { kind: "record"; record: DayRecord }
  | { kind: "refused"; note: string };

export interface DayStore {
  read: () => StoredDay;
  /** Throws when the record could not be saved. The counter keeps counting in memory and says so. */
  write: (record: DayRecord) => void;
}

/** What the ceiling file calls itself, so a file of another shape is refused rather than misread. */
export const DAY_FILE_VERSION = 1;

/** Past the largest ceiling env.ts accepts, so no honest count is ever refused for its size. */
const MAX_STORED_COUNT = 1_000_000;

const storedCount = z.number().int().nonnegative().max(MAX_STORED_COUNT);

/**
 * Every action is required. A file missing one cannot say what was spent on it, and a count that
 * cannot be read is not read as zero.
 */
const dayFileSchema = z.object({
  version: z.literal(DAY_FILE_VERSION),
  day: z.number().int().nonnegative(),
  used: z.object({
    prepares: storedCount,
    generations: storedCount,
    edits: storedCount,
    unseals: storedCount,
    links: storedCount,
  }),
});

/** A store that keeps the record only as long as the process, for tests and for a host with nowhere to write. */
export function memoryDayStore(record?: DayRecord): DayStore {
  let held = record === undefined ? undefined : { day: record.day, used: { ...record.used } };
  return {
    read: () => (held === undefined ? { kind: "none" } : { kind: "record", record: { day: held.day, used: { ...held.used } } }),
    write: (next) => {
      held = { day: next.day, used: { ...next.used } };
    },
  };
}

/**
 * The day's counts as a small JSON file, written to a temp name and renamed into place like the
 * re-check queue's. A missing file is a first boot on a fresh folder and counts from zero; a file
 * that is there and cannot be believed is refused, and the counter reads that as the ceiling
 * already reached (fail closed), never as nothing spent.
 */
export function fileDayStore(filePath: string, options: { rename?: (from: string, to: string) => void } = {}): DayStore {
  return {
    read: () => {
      let text: string;
      try {
        text = readFileSync(filePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return { kind: "none", note: `no ceiling file at ${filePath} yet, counting today from zero` };
        }
        return { kind: "refused", note: `the ceiling file at ${filePath} could not be read` };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return { kind: "refused", note: `the ceiling file at ${filePath} is not JSON` };
      }
      const result = dayFileSchema.safeParse(parsed);
      if (!result.success) {
        return { kind: "refused", note: `the ceiling file at ${filePath} is not a record this version reads` };
      }
      return { kind: "record", record: { day: result.data.day, used: { ...result.data.used } } };
    },
    write: (record) => {
      writeJsonFile(filePath, { version: DAY_FILE_VERSION, day: record.day, used: record.used }, options.rename);
    },
  };
}

/**
 * The live ceiling store: a file in the data folder, or memory under a test runner and on a
 * development host whose folder cannot be written.
 */
export function defaultDayStore(): DayStore {
  const file = stateFile(STATE_FILES.dayCeilings);
  return file === undefined ? memoryDayStore() : fileDayStore(file);
}

export interface GlobalDayOptions {
  store?: DayStore;
  /** Where the boot note, a refused file and a failed save are reported. Silent by default. */
  log?: (line: string) => void;
}

/**
 * How much of today's budget the whole world has spent, per action.
 *
 * Every other limit in this service is per Privy user id, and accounts are free, so nothing bounds
 * what a hundred throwaway accounts can cost in a day. This is that bound: one count per action
 * per UTC day, shared by everyone, checked after the caller's token and their own quota have
 * passed and before a cent of Pinata, OpenAI or sponsored gas is spent.
 *
 * The counts are saved to the store on every take and every give-back and read back at boot, so a
 * deploy or a restart carries today's spend over instead of handing out a second budget. A saved
 * record that cannot be believed is refused and logged, and today's ceiling reads as already
 * reached for every action until midnight UTC; that verdict is written back so a second restart
 * the same day reaches it again and the next day starts clean. Two copies of the service would
 * still count separately, which is why the host runs one. The real bound on sponsored gas is the
 * daily cap in the Privy dashboard, which no code here can enforce.
 *
 * Nothing in here awaits, so a check and the increment that follows it cannot be interleaved by a
 * second request, and one request can only take a slot at the single place its route calls this.
 *
 * The clock is a parameter so a test can walk it over midnight without waiting for one.
 */
export function globalDay(
  max: Record<DayAction, number>,
  now: () => number = Date.now,
  options: GlobalDayOptions = {},
): GlobalDay {
  const store = options.store ?? memoryDayStore();
  const log = options.log ?? ((): void => {});
  const used = Object.fromEntries(DAY_ACTIONS.map((action) => [action, 0])) as Record<DayAction, number>;
  let day = Math.floor(now() / DAY_MS);

  let saveFailed = false;
  const save = (): void => {
    try {
      store.write({ day, used: { ...used } });
      saveFailed = false;
    } catch (error) {
      if (!saveFailed) {
        log(`today's ceilings could not be saved, counting in memory only: ${safeReason(error)}`);
        saveFailed = true;
      }
    }
  };

  const loaded = store.read();
  let refusal = loaded.kind === "refused" ? loaded.note : undefined;
  if (loaded.kind === "record") {
    // A record from tomorrow is a clock that stepped back overnight, which the counter already
    // treats as today. Anything further ahead was not written by this clock and is not believed.
    if (loaded.record.day > day + 1) {
      refusal = "the ceiling file is stamped with a day that has not come yet";
    } else if (loaded.record.day >= day) {
      day = loaded.record.day;
      for (const action of DAY_ACTIONS) {
        used[action] = loaded.record.used[action];
      }
    }
  } else if (loaded.kind === "none" && loaded.note !== undefined) {
    log(loaded.note);
  }
  if (refusal !== undefined) {
    log(`${refusal}, so today's ceiling for every action is read as already reached until midnight UTC`);
    for (const action of DAY_ACTIONS) {
      used[action] = max[action];
    }
    save();
  }

  const currentDay = (): number => {
    const today = Math.floor(now() / DAY_MS);
    // Only a clock that moved forward starts a new day. A host whose clock steps backwards, which
    // is what an NTP correction or a container clock catching up looks like, would otherwise wipe
    // the counts and hand the whole world a second budget for the same day. The greater of the two
    // days is the one everything is reported and compared against, so a backwards step is a no-op.
    if (today > day) {
      day = today;
      for (const action of DAY_ACTIONS) {
        used[action] = 0;
      }
    }
    return day;
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
      save();
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
          save();
        },
      };
    },

    counts(): Record<DayAction, { used: number; max: number }> {
      // Asked for the side effect: a probe read after midnight must not report yesterday's counts.
      currentDay();
      return Object.fromEntries(
        DAY_ACTIONS.map((action) => [action, { used: used[action], max: max[action] }]),
      ) as Record<DayAction, { used: number; max: number }>;
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
