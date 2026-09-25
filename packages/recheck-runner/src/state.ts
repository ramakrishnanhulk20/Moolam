import fs from "node:fs";
import path from "node:path";

/**
 * The little the runner has to remember between passes, and between restarts.
 *
 * It is a spend ledger more than a cache: the day's report count is what holds the daily cap, and
 * losing it would let a restart loop spend the cap again. So it is written to disk on every
 * change, and written the way the verify service writes its queue, to a temporary name and then
 * renamed, so a machine that dies mid-write leaves the old file whole rather than half a new one.
 */
export interface RunnerState {
  /** The UTC date the count below belongs to, as YYYY-MM-DD. */
  day: string;
  /** Broadcast attempts today, whether or not they produced a report. */
  reports: number;
  failures: number;
  /** Epoch seconds before which no pass runs, zero when there is no backoff. */
  backoffUntil: number;
  /** Passport id to the epoch second the runner last finished with it. */
  recent: Record<string, number>;
}

/** How many passports the recent list holds before the oldest are dropped. */
const RECENT_CAP = 500;

export function emptyState(day: string): RunnerState {
  return { day, reports: 0, failures: 0, backoffUntil: 0, recent: {} };
}

export function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** A missing or unreadable file starts an empty day rather than stopping the runner. */
export function loadState(file: string, nowMs: number): RunnerState {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<RunnerState>;
    return rollDay(
      {
        day: typeof parsed.day === "string" ? parsed.day : utcDay(nowMs),
        reports: spentCount(parsed.reports),
        failures: Number(parsed.failures ?? 0),
        backoffUntil: Number(parsed.backoffUntil ?? 0),
        recent: typeof parsed.recent === "object" && parsed.recent !== null ? { ...parsed.recent } : {},
      },
      nowMs,
    );
  } catch {
    return emptyState(utcDay(nowMs));
  }
}

/**
 * The day's count as read back from disk. Missing is a new ledger, zero. Anything else that is not
 * a whole number from zero up reads as the cap used up until the next UTC day (R9): NaN would
 * compare false against the cap all day, and a negative would add to it.
 */
function spentCount(value: unknown): number {
  if (value === undefined) {
    return 0;
  }
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : Number.MAX_SAFE_INTEGER;
}

export function saveState(file: string, state: RunnerState): void {
  const folder = path.dirname(path.resolve(file));
  fs.mkdirSync(folder, { recursive: true });
  const temporary = `${file}.writing`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

/** A new UTC day gives back the day's cap. Nothing else is reset. */
export function rollDay(state: RunnerState, nowMs: number): RunnerState {
  const today = utcDay(nowMs);
  return state.day === today ? state : { ...state, day: today, reports: 0 };
}

/**
 * Remembers that this passport was just handled.
 *
 * It is what stops a passport the index has not caught up on yet, or one that fails for its own
 * reasons, from being run again on the next pass two minutes later. The list is bounded, and the
 * oldest entries go first, because a map that only grows is a leak on a machine nobody watches.
 */
export function noteRecent(state: RunnerState, passportId: string, nowMs: number): RunnerState {
  const recent = { ...state.recent, [passportId.toLowerCase()]: Math.floor(nowMs / 1000) };
  const ids = Object.keys(recent);
  if (ids.length > RECENT_CAP) {
    const oldestFirst = ids.sort((left, right) => (recent[left] ?? 0) - (recent[right] ?? 0));
    for (const id of oldestFirst.slice(0, ids.length - RECENT_CAP)) {
      delete recent[id];
    }
  }
  return { ...state, recent };
}

export function inCooldown(state: RunnerState, passportId: string, nowMs: number, seconds: number): boolean {
  const at = state.recent[passportId.toLowerCase()];
  return at !== undefined && Math.floor(nowMs / 1000) - at < seconds;
}
