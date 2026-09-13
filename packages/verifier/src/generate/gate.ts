/** Too many generations were already in flight for this caller's wait to be worth serving. */
export class Busy extends Error {
  constructor(waitedMs: number) {
    super(`no generation slot came free within ${Math.round(waitedMs / 1000)} seconds`);
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
