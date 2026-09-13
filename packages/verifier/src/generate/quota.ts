const DAY_MS = 24 * 60 * 60 * 1000;

export interface QuotaState {
  used: number;
  limit: number;
  /** Unix seconds: when the oldest generation in the window falls out and a slot comes back. */
  resetsAt: number;
}

export interface Reservation {
  ok: boolean;
  state: QuotaState;
  /** The stamp to hand to `release` when the generation never happened. */
  ticket?: number;
}

export interface DailyQuota {
  take: (userId: string) => Reservation;
  release: (userId: string, ticket: number) => void;
  state: (userId: string) => QuotaState;
}

/**
 * How many generations one verified creator has had in the last 24 hours.
 *
 * The count is kept in this process's memory against the Privy user id, which a caller cannot
 * choose, and it is gone on a restart. That is deliberate for now: a creator who happens to catch
 * a redeploy gets a few extra pictures, which costs cents, and the alternative is a Redis this
 * service does not otherwise need. Two copies of the service would each count separately for the
 * same reason.
 *
 * Nothing here awaits, so a check and the reservation that follows it cannot be interleaved by a
 * second request.
 */
export function dailyQuota(limit: number, windowMs: number = DAY_MS): DailyQuota {
  const spends = new Map<string, number[]>();

  const current = (userId: string, now: number): number[] => {
    const kept = (spends.get(userId) ?? []).filter((at) => now - at < windowMs);
    if (kept.length === 0) {
      spends.delete(userId);
    } else {
      spends.set(userId, kept);
    }
    return kept;
  };

  const describe = (kept: number[], now: number): QuotaState => {
    const oldest = kept[0];
    return {
      used: kept.length,
      limit,
      resetsAt: Math.floor(((oldest === undefined ? now : oldest) + windowMs) / 1000),
    };
  };

  return {
    take(userId: string): Reservation {
      const now = Date.now();
      const kept = current(userId, now);
      if (kept.length >= limit) {
        return { ok: false, state: describe(kept, now) };
      }
      kept.push(now);
      spends.set(userId, kept);
      return { ok: true, state: describe(kept, now), ticket: now };
    },

    release(userId: string, ticket: number): void {
      const kept = spends.get(userId);
      if (kept === undefined) return;
      const at = kept.indexOf(ticket);
      if (at === -1) return;
      kept.splice(at, 1);
      if (kept.length === 0) spends.delete(userId);
    },

    state(userId: string): QuotaState {
      const now = Date.now();
      return describe(current(userId, now), now);
    },
  };
}
