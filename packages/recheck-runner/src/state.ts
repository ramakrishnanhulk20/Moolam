import fs from "node:fs";
import path from "node:path";

/**
 * The little the runner has to remember between passes, and between restarts.
 *
 * It is a spend ledger more than a cache: the day's report count is what holds the daily cap, and
 * losing it would let a restart loop spend the cap again. So it is written to disk on every
 * change, and written the way the verify service writes its queue, to a temporary name and then
 * renamed, so a machine that dies mid-write leaves the old file whole rather than half a new one.
 *
 * Each passport the runner has dealt with sits in at most a few of the maps below, and every map is
 * bounded, oldest first out, because a map that only grows is a leak on a machine nobody watches.
 */
export interface RunnerState {
  /** The UTC date the count below belongs to, as YYYY-MM-DD. */
  day: string;
  /** Broadcast attempts today, whether or not they produced a report. */
  reports: number;
  failures: number;
  /** Epoch seconds before which no pass runs, zero when there is no backoff. */
  backoffUntil: number;
  /** Passport id to the epoch second a paid run on it last ended with no verdict. */
  recent: Record<string, number>;
  /**
   * Passport id to the epoch second the sweep last set it aside without a run: a seed test card, a
   * sealed picture, a private run this machine cannot make. Any of those can change, so a request
   * for one is still looked at; only the sweep leaves it alone for the cooldown.
   */
  held: Record<string, number>;
  /** Passports settled as not re-checkable, with the reason. Never run and never read again. */
  closed: Record<string, Closure>;
  /** Passports waiting out a passing failure: a gateway miss, a timeout, a 5xx. */
  waiting: Record<string, Wait>;
  /** How many reports the receiver has refused for each passport. */
  refusals: Record<string, number>;
  /** Every report this runner broadcast, by passport: the guard against a second one that does not read the index. */
  sent: Record<string, Sent>;
  /**
   * Passport id to the epoch second a broadcast run on it printed no report hash while the chain
   * could not be read to say whether its verdict landed. The report may be in the registry, so the
   * passport is not run again from any source until the index shows its verdict or the cooldown ends.
   */
  undecided: Record<string, number>;
  /** The circuit breaker on refused reports. Survives a restart; only the operator clears it. */
  breaker: Breaker;
}

export interface Breaker {
  /** The passports whose reports the receiver refused since the last report that landed, oldest first. */
  streak: string[];
  /** Set when the streak reached BREAKER_REFUSALS. While set, nothing is sent. */
  tripped: Closure | null;
}

/**
 * Refused reports in a row, on different passports, that trip the breaker. One passport refused
 * twice is that passport's problem and settles it; three different ones refused with nothing
 * landing between them is the receiver's: a forwarder or author pin that is wrong, a wallet that
 * is not the one it expects. Every further report would be paid for and refused the same way.
 */
export const BREAKER_REFUSALS = 3;

export interface Closure {
  /** Epoch seconds. */
  at: number;
  reason: string;
}

export interface Wait {
  /** Epoch seconds before which the passport is not tried again. */
  until: number;
  /** Passing failures in a row. Each one doubles the wait, up to the cooldown. */
  misses: number;
  reason: string;
}

export interface Sent {
  /** Epoch seconds. */
  at: number;
  tx: string;
  /** Whether the registry recorded the verdict. Null while its receipt has not been read. */
  landed: boolean | null;
}

/** How many passports each short-lived map holds before the oldest are dropped. */
const RECENT_CAP = 500;

/**
 * How many settled passports and sent reports are kept. Larger, because dropping one of these costs
 * a document read (closed) or trusts the index again (sent) rather than merely retrying sooner.
 */
const LONG_CAP = 2_000;

/**
 * How long a sent report is remembered: a week, far longer than the index has ever been behind.
 * After that the index is trusted to show the attestation, which is the assumption the README names.
 */
export const SENT_MEMORY_SECONDS = 7 * 24 * 60 * 60;

export function emptyState(day: string): RunnerState {
  return {
    day,
    reports: 0,
    failures: 0,
    backoffUntil: 0,
    recent: {},
    held: {},
    closed: {},
    waiting: {},
    refusals: {},
    sent: {},
    undecided: {},
    breaker: { streak: [], tripped: null },
  };
}

export function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * A missing or unreadable file starts an empty day rather than stopping the runner. A file written
 * before a map existed reads that map as empty, and an entry of the wrong shape is dropped.
 */
export function loadState(file: string, nowMs: number): RunnerState {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Record<keyof RunnerState, unknown>>;
    return rollDay(
      {
        day: typeof parsed.day === "string" ? parsed.day : utcDay(nowMs),
        reports: spentCount(parsed.reports),
        failures: Number(parsed.failures ?? 0),
        backoffUntil: Number(parsed.backoffUntil ?? 0),
        recent: entries(parsed.recent, (value) => (isCount(value) ? value : null)),
        held: entries(parsed.held, (value) => (isCount(value) ? value : null)),
        closed: entries(parsed.closed, closureOf),
        waiting: entries(parsed.waiting, waitOf),
        refusals: entries(parsed.refusals, (value) => (isCount(value) ? value : null)),
        sent: entries(parsed.sent, sentOf),
        undecided: entries(parsed.undecided, (value) => (isCount(value) ? value : null)),
        breaker: breakerOf(parsed.breaker),
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

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function entries<T>(value: unknown, read: (entry: unknown) => T | null): Record<string, T> {
  const out: Record<string, T> = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return out;
  }
  for (const [key, entry] of Object.entries(value)) {
    const kept = read(entry);
    if (kept !== null) {
      out[key.toLowerCase()] = kept;
    }
  }
  return out;
}

function closureOf(value: unknown): Closure | null {
  const entry = value as Partial<Closure> | null;
  return typeof entry === "object" && entry !== null && isCount(entry.at) && typeof entry.reason === "string"
    ? { at: entry.at, reason: entry.reason }
    : null;
}

function waitOf(value: unknown): Wait | null {
  const entry = value as Partial<Wait> | null;
  return typeof entry === "object" && entry !== null && isCount(entry.until) && isCount(entry.misses) && typeof entry.reason === "string"
    ? { until: entry.until, misses: entry.misses, reason: entry.reason }
    : null;
}

/**
 * The breaker as written on disk. A tripped flag that is there but unreadable reads as tripped:
 * a breaker that cannot be read is not a breaker that can be trusted to be clear.
 */
function breakerOf(value: unknown): Breaker {
  if (value === undefined) {
    return { streak: [], tripped: null };
  }
  const entry = (typeof value === "object" && value !== null ? value : {}) as Partial<Record<keyof Breaker, unknown>>;
  const streak = Array.isArray(entry.streak) ? entry.streak.filter((one): one is string => typeof one === "string") : [];
  if (entry.tripped === null) {
    return { streak, tripped: null };
  }
  return { streak, tripped: closureOf(entry.tripped) ?? { at: 0, reason: "the breaker in the state file could not be read" } };
}

function sentOf(value: unknown): Sent | null {
  const entry = value as Partial<Sent> | null;
  return typeof entry === "object" &&
    entry !== null &&
    isCount(entry.at) &&
    typeof entry.tx === "string" &&
    (entry.landed === true || entry.landed === false || entry.landed === null)
    ? { at: entry.at, tx: entry.tx, landed: entry.landed }
    : null;
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

/** One map with this passport set, and its oldest entries dropped past the cap. */
function bounded<T>(map: Record<string, T>, passportId: string, value: T, cap: number, stamp: (entry: T) => number): Record<string, T> {
  const next = { ...map, [passportId.toLowerCase()]: value };
  const ids = Object.keys(next);
  if (ids.length > cap) {
    const oldestFirst = ids.sort((left, right) => stamp(next[left] as T) - stamp(next[right] as T));
    for (const id of oldestFirst.slice(0, ids.length - cap)) {
      delete next[id];
    }
  }
  return next;
}

function without<T>(map: Record<string, T>, passportId: string): Record<string, T> {
  const id = passportId.toLowerCase();
  if (!(id in map)) {
    return map;
  }
  const next = { ...map };
  delete next[id];
  return next;
}

function epoch(nowMs: number): number {
  return Math.floor(nowMs / 1000);
}

/**
 * Remembers that a paid run on this passport ended with no verdict, so it is not run again on the
 * next pass two minutes later but after the cooldown. A passing wait it had is over.
 */
export function noteRecent(state: RunnerState, passportId: string, nowMs: number): RunnerState {
  const recent = bounded(state.recent, passportId, epoch(nowMs), RECENT_CAP, (at) => at);
  return { ...state, recent, waiting: without(state.waiting, passportId) };
}

export function inCooldown(state: RunnerState, passportId: string, nowMs: number, seconds: number): boolean {
  const at = state.recent[passportId.toLowerCase()];
  return at !== undefined && epoch(nowMs) - at < seconds;
}

/** Remembers that the sweep set this passport aside without a run. */
export function noteHeld(state: RunnerState, passportId: string, nowMs: number): RunnerState {
  const held = bounded(state.held, passportId, epoch(nowMs), RECENT_CAP, (at) => at);
  return { ...state, held, waiting: without(state.waiting, passportId) };
}

export function isHeld(state: RunnerState, passportId: string, nowMs: number, seconds: number): boolean {
  const at = state.held[passportId.toLowerCase()];
  return at !== undefined && epoch(nowMs) - at < seconds;
}

/** Settles a passport as not re-checkable, for good, with the reason every later request is given. */
export function noteClosed(state: RunnerState, passportId: string, reason: string, nowMs: number): RunnerState {
  const closed = bounded(state.closed, passportId, { at: epoch(nowMs), reason }, LONG_CAP, (entry) => entry.at);
  return { ...state, closed, waiting: without(state.waiting, passportId) };
}

export function closureFor(state: RunnerState, passportId: string): Closure | undefined {
  return state.closed[passportId.toLowerCase()];
}

/**
 * Puts a passport into a short wait after a passing failure. The first wait is `retrySeconds`, and
 * each miss in a row doubles it up to `ceilingSeconds`, the cooldown, so a gateway that is down for
 * an hour costs a few reads and one that never answers for this passport ends up at the same pace
 * as any other failure.
 */
export function noteWaiting(
  state: RunnerState,
  passportId: string,
  reason: string,
  nowMs: number,
  retrySeconds: number,
  ceilingSeconds: number,
): RunnerState {
  const misses = (state.waiting[passportId.toLowerCase()]?.misses ?? 0) + 1;
  const wait = Math.min(ceilingSeconds, retrySeconds * 2 ** Math.min(misses - 1, 20));
  const waiting = bounded(state.waiting, passportId, { until: epoch(nowMs) + wait, misses, reason }, RECENT_CAP, (entry) => entry.until);
  return { ...state, waiting };
}

/** The wait this passport is in, or undefined when it has none or it is over. */
export function waitFor(state: RunnerState, passportId: string, nowMs: number): Wait | undefined {
  const wait = state.waiting[passportId.toLowerCase()];
  return wait !== undefined && wait.until > epoch(nowMs) ? wait : undefined;
}

/** Counts one more report the receiver refused for this passport, and answers the new count. */
export function noteRefusal(state: RunnerState, passportId: string): { state: RunnerState; count: number } {
  const count = (state.refusals[passportId.toLowerCase()] ?? 0) + 1;
  const refusals = bounded(state.refusals, passportId, count, RECENT_CAP, (entry) => entry);
  return { state: { ...state, refusals }, count };
}

/** Records a report this runner broadcast, whether or not its receipt has been read yet. */
export function noteSent(state: RunnerState, passportId: string, sent: Sent): RunnerState {
  const kept = bounded(state.sent, passportId, sent, LONG_CAP, (entry) => entry.at);
  const settled = sent.landed === true ? { waiting: without(state.waiting, passportId), refusals: without(state.refusals, passportId) } : {};
  return { ...state, sent: kept, ...settled };
}

/**
 * Remembers a paid run that printed no report hash and whose verdict the chain could not be read to
 * confirm or rule out. Kept with the long lists, because dropping one early could buy a second report.
 */
export function noteUndecided(state: RunnerState, passportId: string, nowMs: number): RunnerState {
  const undecided = bounded(state.undecided, passportId, epoch(nowMs), LONG_CAP, (at) => at);
  return { ...state, undecided, waiting: without(state.waiting, passportId) };
}

/** The epoch second an undecided run on this passport stops holding it, or undefined when none holds it now. */
export function undecidedUntil(state: RunnerState, passportId: string, nowMs: number, seconds: number): number | undefined {
  const at = state.undecided[passportId.toLowerCase()];
  return at !== undefined && epoch(nowMs) - at < seconds ? at + seconds : undefined;
}

/** The report this runner sent for this passport within the memory window, if it sent one. */
export function sentFor(state: RunnerState, passportId: string, nowMs: number): Sent | undefined {
  const sent = state.sent[passportId.toLowerCase()];
  return sent !== undefined && epoch(nowMs) - sent.at < SENT_MEMORY_SECONDS ? sent : undefined;
}

/**
 * Adds one refused report to the breaker's streak, and trips it once BREAKER_REFUSALS different
 * passports are in the streak. A passport already in the streak is not counted twice.
 */
export function noteBreakerRefusal(state: RunnerState, passportId: string, nowMs: number): RunnerState {
  const id = passportId.toLowerCase();
  const streak = state.breaker.streak.includes(id) ? state.breaker.streak : [...state.breaker.streak, id];
  if (state.breaker.tripped !== null || streak.length < BREAKER_REFUSALS) {
    return { ...state, breaker: { ...state.breaker, streak } };
  }
  const reason = `the receiver refused reports for ${streak.length} different passports in a row (${streak.map((one) => one.slice(0, 12)).join(", ")}) with none landing between them`;
  return { ...state, breaker: { streak, tripped: { at: epoch(nowMs), reason } } };
}

/** A report that landed: the receiver is taking reports, so the streak starts again. */
export function noteBreakerLanded(state: RunnerState): RunnerState {
  return state.breaker.streak.length === 0 ? state : { ...state, breaker: { ...state.breaker, streak: [] } };
}

/** The operator's reset: the breaker clear and the streak empty. */
export function clearBreaker(state: RunnerState): RunnerState {
  return { ...state, breaker: { streak: [], tripped: null } };
}
