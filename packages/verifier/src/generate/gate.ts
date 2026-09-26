/**
 * The service was too busy for this caller's wait to be worth serving. Both gates throw it: the
 * one in front of every picture decode and the one in front of drawing.
 */
export class Busy extends Error {
  /** A queue this long is the service being unavailable for a moment, not the caller's mistake. */
  readonly statusCode = 503;

  constructor(waitedMs: number) {
    super(`the service was busy and nothing came free for this request within ${Math.round(waitedMs / 1000)} seconds`);
    this.name = "Busy";
  }
}

interface Waiter {
  wake: () => void;
  dropped: boolean;
}

/**
 * A first come, first served gate that lets `limit` tasks run at once and gives up waiting.
 *
 * The match gate in server.ts parks a caller until a slot frees, which is right for work that
 * takes under a second. A generation takes tens of seconds, so a caller who would sit behind a
 * queue for longer than `maxWaitMs` is told the service is busy instead of holding a connection
 * open with nothing happening on it. A waiter that gave up is skipped when a slot frees, so its
 * turn is not spent on a request nobody is listening for any more.
 */
export function waitingGate(
  limit: number,
  maxWaitMs: number,
): <T>(task: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: Waiter[] = [];

  const wakeNext = (): void => {
    while (waiting.length > 0) {
      const waiter = waiting.shift() as Waiter;
      if (waiter.dropped) continue;
      waiter.wake();
      return;
    }
  };

  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (running >= limit || waiting.length > 0) {
      await new Promise<void>((resolve, reject) => {
        const waiter: Waiter = { dropped: false, wake: () => undefined };
        const timer = setTimeout(() => {
          waiter.dropped = true;
          reject(new Busy(maxWaitMs));
        }, maxWaitMs);
        // A queued caller must not be the reason the process cannot shut down.
        timer.unref?.();
        waiter.wake = () => {
          clearTimeout(timer);
          resolve();
        };
        waiting.push(waiter);
      });
    }

    running += 1;
    try {
      return await task();
    } finally {
      running -= 1;
      wakeNext();
    }
  };
}

/** Which work a turn at the fair gate is for: a verify, or a creator's registration, edit or unseal. */
export type GateLane = "verify" | "studio";

/**
 * Asked as a turn comes up. An error means the caller has left: the turn is skipped rather than
 * run, and the call rejects with that error.
 */
export type GoneCheck = () => Error | undefined;

interface Turn {
  lane: GateLane;
  caller: string | undefined;
  gone: GoneCheck | undefined;
  start: () => void;
  skip: (error: Error) => void;
}

/**
 * The gate every picture decode passes through, fair between callers and between the two kinds of
 * work (review pass 8, V74).
 *
 * At most `verifySlots + studioSlots` tasks run at once. Verify work may take at most `verifySlots`
 * of them, so `studioSlots` stay free for /prepare, /edit and /unseal however many verifies queue;
 * studio work may take any free slot. One caller, named by its rate-limit key, runs one task at a
 * time: its other requests wait behind its own while other callers go ahead of them. A task that
 * names no caller is held to the slot counts only. Among the waiters allowed to run, callers take
 * turns: the one whose last turn started longest ago goes first, and a caller with no turn yet goes
 * before all of them, oldest waiter first. Serving the oldest waiter instead let two callers with a
 * standing backlog hold both verify slots, since their own queued turns were always older than a
 * newcomer's, and everyone else waited out most of `maxWaitMs` or was turned away (review pass 9,
 * V77). Every waiter gives up with Busy after `maxWaitMs`, as waitingGate does. A turn whose caller
 * has hung up by the time it comes up is skipped, not run, and its slot goes to the next waiter: a
 * picture decode for nobody is the most expensive way to spend a slot.
 *
 * The queue is walked once for each turn started when a task ends. Its length is bounded by the
 * rate limit times the wait limit, since no waiter stays longer than `maxWaitMs`, and a caller's
 * last start is kept only while it has a turn running or waiting.
 */
export function fairGate(options: {
  verifySlots: number;
  studioSlots: number;
  maxWaitMs: number;
}): <T>(lane: GateLane, caller: string | undefined, task: () => Promise<T>, gone?: GoneCheck) => Promise<T> {
  const total = options.verifySlots + options.studioSlots;
  let running = 0;
  let verifying = 0;
  const callers = new Set<string>();
  const queue: Turn[] = [];
  // When each caller's last turn started, counted in turns rather than read off a clock, so two
  // starts in the same millisecond still have an order.
  const lastStart = new Map<string, number>();
  let starts = 0;

  const mayRun = (lane: GateLane, caller: string | undefined): boolean =>
    running < total &&
    (lane !== "verify" || verifying < options.verifySlots) &&
    (caller === undefined || !callers.has(caller));

  const take = (lane: GateLane, caller: string | undefined): void => {
    running += 1;
    if (lane === "verify") verifying += 1;
    starts += 1;
    if (caller !== undefined) {
      callers.add(caller);
      lastStart.set(caller, starts);
    }
  };

  const leave = (lane: GateLane, caller: string | undefined): void => {
    running -= 1;
    if (lane === "verify") verifying -= 1;
    if (caller !== undefined) {
      callers.delete(caller);
      if (!queue.some((turn) => turn.caller === caller)) lastStart.delete(caller);
    }
  };

  /** Where in the queue the next turn to start is, or -1 when no waiter may run. */
  const next = (): number => {
    let best = -1;
    let bestStart = Number.POSITIVE_INFINITY;
    for (let at = 0; at < queue.length; at += 1) {
      const turn = queue[at] as Turn;
      if (!mayRun(turn.lane, turn.caller)) continue;
      // A caller with no turn yet, or a task that names none, counts as never having started.
      const started = turn.caller === undefined ? 0 : (lastStart.get(turn.caller) ?? 0);
      if (started < bestStart) {
        best = at;
        bestStart = started;
      }
    }
    return best;
  };

  // A turn becomes able to run only when a task ends, so every waiter that could run has been
  // started by the time this returns, and a new arrival that may run jumps nobody who could.
  const serve = (): void => {
    while (running < total) {
      const at = next();
      if (at === -1) return;
      const [turn] = queue.splice(at, 1) as [Turn];
      const left = turn.gone?.();
      if (left !== undefined) {
        const skipped = turn.caller;
        if (skipped !== undefined && !callers.has(skipped) && !queue.some((one) => one.caller === skipped)) {
          lastStart.delete(skipped);
        }
        turn.skip(left);
        continue;
      }
      take(turn.lane, turn.caller);
      turn.start();
    }
  };

  return async <T>(lane: GateLane, caller: string | undefined, task: () => Promise<T>, gone?: GoneCheck): Promise<T> => {
    if (mayRun(lane, caller)) {
      const left = gone?.();
      if (left !== undefined) {
        throw left;
      }
      take(lane, caller);
    } else {
      await new Promise<void>((resolve, reject) => {
        const turn: Turn = { lane, caller, gone, start: () => undefined, skip: () => undefined };
        const timer = setTimeout(() => {
          const at = queue.indexOf(turn);
          if (at !== -1) queue.splice(at, 1);
          if (caller !== undefined && !callers.has(caller) && !queue.some((one) => one.caller === caller)) {
            lastStart.delete(caller);
          }
          reject(new Busy(options.maxWaitMs));
        }, options.maxWaitMs);
        // A queued caller must not be the reason the process cannot shut down.
        timer.unref?.();
        turn.start = () => {
          clearTimeout(timer);
          resolve();
        };
        turn.skip = (error) => {
          clearTimeout(timer);
          reject(error);
        };
        queue.push(turn);
      });
    }

    try {
      return await task();
    } finally {
      leave(lane, caller);
      serve();
    }
  };
}
