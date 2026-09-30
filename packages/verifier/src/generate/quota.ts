import { readFileSync } from "node:fs";
import { z } from "zod";
import { safeReason } from "../net/errorText.js";
import { STATE_FILES, stateFile, writeJsonFile } from "../stateDir.js";

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
 * Every user's spends in the window, as they are kept on disk. `closedUntil` is set only after a
 * file that could not be believed: until then every user reads as having spent their whole day.
 */
export interface QuotaRecord {
  closedUntil?: number;
  spends: Record<string, number[]>;
}

export type StoredQuota =
  | { kind: "none"; note?: string }
  | { kind: "record"; record: QuotaRecord }
  | { kind: "refused"; note: string };

export interface QuotaStore {
  read: () => StoredQuota;
  /** Throws when the record could not be saved. The quota keeps counting in memory and says so. */
  write: (record: QuotaRecord) => void;
}

/** What a quota file calls itself, so a file of another shape is refused rather than misread. */
export const QUOTA_FILE_VERSION = 1;

/** A Privy user id is a short did; anything this long was not written by this service. */
const MAX_USER_ID_CHARS = 256;

/** Past the largest daily allowance env.ts accepts. */
const MAX_STAMPS_PER_USER = 1000;

/**
 * Far past the users a day's global ceilings let through, and small enough that a file stuffed with
 * made-up users is refused before it is loaded into memory.
 */
const MAX_USERS = 100_000;

const quotaFileSchema = z.object({
  version: z.literal(QUOTA_FILE_VERSION),
  closedUntil: z.number().int().nonnegative().optional(),
  spends: z
    .record(
      z.string().min(1).max(MAX_USER_ID_CHARS),
      z.array(z.number().int().nonnegative()).max(MAX_STAMPS_PER_USER),
    )
    .refine((spends) => Object.keys(spends).length <= MAX_USERS, { message: "too many users" }),
});

/** A store that keeps nothing past the process, for tests and for a host with nowhere to write. */
export function memoryQuotaStore(record?: QuotaRecord): QuotaStore {
  let held = record;
  return {
    read: () => (held === undefined ? { kind: "none" } : { kind: "record", record: structuredClone(held) }),
    write: (next) => {
      held = structuredClone(next);
    },
  };
}

/**
 * One quota as a small JSON file, written to a temp name and renamed into place like the re-check
 * queue's. A missing file counts from zero; a file that is there and cannot be believed is refused.
 */
export function fileQuotaStore(filePath: string, options: { rename?: (from: string, to: string) => void } = {}): QuotaStore {
  return {
    read: () => {
      let text: string;
      try {
        text = readFileSync(filePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return { kind: "none", note: `no quota file at ${filePath} yet, counting from zero` };
        }
        return { kind: "refused", note: `the quota file at ${filePath} could not be read` };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return { kind: "refused", note: `the quota file at ${filePath} is not JSON` };
      }
      const result = quotaFileSchema.safeParse(parsed);
      if (!result.success) {
        return { kind: "refused", note: `the quota file at ${filePath} is not a record this version reads` };
      }
      return {
        kind: "record",
        record: { closedUntil: result.data.closedUntil, spends: Object.fromEntries(Object.entries(result.data.spends)) },
      };
    },
    write: (record) => {
      writeJsonFile(filePath, { version: QUOTA_FILE_VERSION, ...record }, options.rename);
    },
  };
}

/** The three allowances this service counts per creator, each in its own file. */
export type QuotaName = "generate" | "edit" | "unseal";

const QUOTA_FILES: Record<QuotaName, string> = {
  generate: STATE_FILES.generateQuota,
  edit: STATE_FILES.editQuota,
  unseal: STATE_FILES.unsealQuota,
};

/**
 * The live store for one allowance: a file in the data folder, or memory under a test runner and on
 * a development host whose folder cannot be written.
 */
export function defaultQuotaStore(name: QuotaName): QuotaStore {
  const file = stateFile(QUOTA_FILES[name]);
  return file === undefined ? memoryQuotaStore() : fileQuotaStore(file);
}

export interface DailyQuotaOptions {
  windowMs?: number;
  now?: () => number;
  store?: QuotaStore;
  /** Where the boot note, a refused file and a failed save are reported. Silent by default. */
  log?: (line: string) => void;
}

/**
 * How many generations one verified creator has had in the last 24 hours.
 *
 * The count is kept against the Privy user id, which a caller cannot choose, and saved to the store
 * on every take and every release, so a deploy or a restart does not hand anyone their allowance
 * back. A saved file that cannot be believed is refused and logged, and every creator reads as
 * having spent their whole allowance for one window from that boot; that verdict is saved too, so
 * a restart inside the window reaches it again. Two copies of the service would still count
 * separately, which is why the host runs one.
 *
 * Nothing here awaits, so a check and the reservation that follows it cannot be interleaved by a
 * second request.
 */
export function dailyQuota(limit: number, options: DailyQuotaOptions = {}): DailyQuota {
  const windowMs = options.windowMs ?? DAY_MS;
  // Looked up on every call rather than held, so a clock swapped in after this is built still counts.
  const clock = options.now ?? ((): number => Date.now());
  const store = options.store ?? memoryQuotaStore();
  const log = options.log ?? ((): void => {});
  const spends = new Map<string, number[]>();
  let closedUntil: number | undefined;

  const live = (stamps: readonly number[], now: number): number[] => stamps.filter((at) => now - at < windowMs);

  let saveFailed = false;
  const save = (now: number): void => {
    const kept: Record<string, number[]> = {};
    for (const [userId, stamps] of spends) {
      const inWindow = live(stamps, now);
      if (inWindow.length > 0) kept[userId] = inWindow;
    }
    try {
      store.write(closedUntil !== undefined && closedUntil > now ? { closedUntil, spends: kept } : { spends: kept });
      saveFailed = false;
    } catch (error) {
      if (!saveFailed) {
        log(`a quota could not be saved, counting in memory only: ${safeReason(error)}`);
        saveFailed = true;
      }
    }
  };

  const bootedAt = clock();
  const loaded = store.read();
  let refusal = loaded.kind === "refused" ? loaded.note : undefined;
  if (loaded.kind === "record") {
    const { record } = loaded;
    // A stamp or a closure further ahead than one window was not written by this clock, and a
    // stamp that far ahead would hold a creator's slot for as long as it says.
    const tooFar = (at: number): boolean => at > bootedAt + windowMs;
    if ((record.closedUntil !== undefined && tooFar(record.closedUntil)) || Object.values(record.spends).some((stamps) => stamps.some(tooFar))) {
      refusal = "the quota file holds a time that has not come yet";
    } else {
      closedUntil = record.closedUntil;
      for (const [userId, stamps] of Object.entries(record.spends)) {
        const inWindow = live(stamps, bootedAt).sort((a, b) => a - b);
        if (inWindow.length > 0) spends.set(userId, inWindow);
      }
    }
  } else if (loaded.kind === "none" && loaded.note !== undefined) {
    log(loaded.note);
  }
  if (refusal !== undefined) {
    closedUntil = bootedAt + windowMs;
    spends.clear();
    log(`${refusal}, so every creator reads as having spent this allowance until ${new Date(closedUntil).toISOString()}`);
    save(bootedAt);
  }

  const closedState = (): QuotaState | undefined =>
    closedUntil !== undefined && clock() < closedUntil
      ? { used: limit, limit, resetsAt: Math.floor(closedUntil / 1000) }
      : undefined;

  const current = (userId: string, now: number): number[] => {
    const kept = live(spends.get(userId) ?? [], now);
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
      const closed = closedState();
      if (closed !== undefined) {
        return { ok: false, state: closed };
      }
      const now = clock();
      const kept = current(userId, now);
      if (kept.length >= limit) {
        return { ok: false, state: describe(kept, now) };
      }
      kept.push(now);
      spends.set(userId, kept);
      save(now);
      return { ok: true, state: describe(kept, now), ticket: now };
    },

    release(userId: string, ticket: number): void {
      const kept = spends.get(userId);
      if (kept === undefined) return;
      const at = kept.indexOf(ticket);
      if (at === -1) return;
      kept.splice(at, 1);
      if (kept.length === 0) spends.delete(userId);
      save(clock());
    },

    state(userId: string): QuotaState {
      const closed = closedState();
      if (closed !== undefined) {
        return closed;
      }
      const now = clock();
      return describe(current(userId, now), now);
    },
  };
}
