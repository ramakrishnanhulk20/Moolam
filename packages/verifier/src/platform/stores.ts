import path from "node:path";
import type { TypedDataDomain } from "viem";
import { MAX_UPLOAD_BYTES } from "../env.js";
import { dailyQuota, fileQuotaStore, memoryQuotaStore, type DailyQuota } from "../generate/quota.js";
import { fileDayStore, globalDay, memoryDayStore, type GlobalDay } from "../limits/globalDay.js";
import { PLATFORM_STATE_FILES, stateFile } from "../stateDir.js";
import { fileNonceStore, memoryNonceStore, nonceMemory, type NonceMemory } from "./nonces.js";
import { pendingStore, type PendingStore } from "./pending.js";

/**
 * What the platform routes let through. The per-key quota is what one platform may cost in a day;
 * the ceiling is what every platform together may, and it still holds when a key leaks (P7). The byte
 * ceiling bounds the disk one platform's waiting co-signs may fill.
 */
export interface PlatformLimits {
  /** Prepares one platform key may make in a rolling 24 hours. */
  perKeyPerDay: number;
  /** Prepares every platform together may make in one UTC day. Zero closes the routes. */
  perDay: number;
  /** Frozen bytes one platform may hold in co-signs still waiting on a creator or a signature. */
  frozenBytesPerKey: number;
}

/**
 * Sized for the demo platform's ten pictures with a wide margin, and far under the studio's own 300
 * a day, since each prepare costs a C2PA signing and four pins. Five full uploads of frozen files per
 * platform is 100 MiB of the volume.
 */
export const DEFAULT_PLATFORM_LIMITS: PlatformLimits = {
  perKeyPerDay: 100,
  perDay: 500,
  frozenBytesPerKey: 5 * MAX_UPLOAD_BYTES,
};

export interface PlatformStores {
  quota: DailyQuota;
  day: GlobalDay;
  nonces: NonceMemory;
  /** Undefined on a host with nowhere to freeze files, where co-sign mode answers 503. */
  pending: PendingStore | undefined;
}

/**
 * The four stores the platform routes keep. With `dir` every one lives under it, which is how a
 * test gets a real folder; without it each is the named file in the data folder, and under a test
 * runner or on a host whose folder cannot be written the three counters are held in memory and
 * there is no pending store at all, because a co-sign that cannot freeze its files must not start.
 */
export function platformStores(
  dir: string | undefined,
  limits: PlatformLimits,
  dom: TypedDataDomain,
  log: (line: string) => void,
): PlatformStores {
  const where = (name: string): string | undefined => (dir === undefined ? stateFile(name) : path.join(dir, name));
  const quotaFile = where(PLATFORM_STATE_FILES.quota);
  const dayFile = where(PLATFORM_STATE_FILES.dayCeiling);
  const nonceFile = where(PLATFORM_STATE_FILES.nonces);
  const pendingDir = where(PLATFORM_STATE_FILES.pending);
  return {
    quota: dailyQuota(limits.perKeyPerDay, {
      store: quotaFile === undefined ? memoryQuotaStore() : fileQuotaStore(quotaFile),
      log,
    }),
    // The studio's day counter, with its fail-closed file, reused under its own file: only its
    // "prepares" count is ever taken here, and every other action is shut.
    day: globalDay(
      { prepares: limits.perDay, generations: 0, edits: 0, unseals: 0, links: 0 },
      Date.now,
      { store: dayFile === undefined ? memoryDayStore() : fileDayStore(dayFile), log },
    ),
    nonces: nonceMemory(nonceFile === undefined ? memoryNonceStore() : fileNonceStore(nonceFile), { log }),
    pending: pendingDir === undefined ? undefined : pendingStore(pendingDir, dom),
  };
}
