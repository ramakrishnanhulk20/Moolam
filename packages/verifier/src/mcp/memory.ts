/**
 * A short memory in front of one kind of read, keyed by a value a caller chose.
 *
 * Every MCP read keyed by a caller's value goes through one of these (M5), so a model that loops
 * on one passport costs the chain or the gateway one read per `ttlMs`, however many callers ask:
 * a read already in flight for a key is shared rather than repeated. Only answers are kept; a read
 * that throws is never remembered, so an outage is not pinned past the moment it ends. The oldest
 * entry leaves when `maxEntries` is reached, so a flood of distinct keys cannot grow this process.
 */
export interface HeldReads<V> {
  read: (key: string, load: () => Promise<V>) => Promise<V>;
}

export function heldReads<V>(options: { ttlMs: number; maxEntries: number; clock?: () => number }): HeldReads<V> {
  const clock = options.clock ?? Date.now;
  const held = new Map<string, { value: V; expiresAt: number }>();
  const inFlight = new Map<string, Promise<V>>();

  const keep = (key: string, value: V, startedAt: number): void => {
    held.delete(key);
    while (held.size >= options.maxEntries) {
      const oldest = held.keys().next();
      if (oldest.done === true) {
        break;
      }
      held.delete(oldest.value);
    }
    held.set(key, { value, expiresAt: startedAt + options.ttlMs });
  };

  return {
    read: async (key, load) => {
      const hit = held.get(key);
      if (hit !== undefined) {
        if (hit.expiresAt > clock()) {
          return hit.value;
        }
        held.delete(key);
      }
      const running = inFlight.get(key);
      if (running !== undefined) {
        return await running;
      }
      const startedAt = clock();
      const reading = load().then((value) => {
        keep(key, value, startedAt);
        return value;
      });
      inFlight.set(key, reading);
      try {
        return await reading;
      } finally {
        inFlight.delete(key);
      }
    },
  };
}
