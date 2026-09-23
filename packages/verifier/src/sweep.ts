import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";
import { env, type PrivateSweepMode } from "./env.js";
import {
  PRIVATE_PREFIX_MAX_FILES,
  PRIVATE_PREFIX_MAX_PAGES,
  deletePrivateFile,
  listPrivateByPrefix,
  type PrivateListing,
} from "./ipfs/pinata.js";
import { readClient } from "./reputation/registry.js";
import { privateThumbnailName } from "./sealed.js";
import type { Hex } from "./types.js";
import { registryUnsealAbi } from "./unseal.js";

const HOUR_MS = 60 * 60 * 1000;

/**
 * The first run waits an hour after boot and never happens at boot (ruling D5): Railway redeploys
 * on every push, and a sweep at boot would run as often as the code changes, each time against an
 * RPC and a Pinata account that may still be settling.
 */
export const SWEEP_FIRST_RUN_MS = HOUR_MS;
export const SWEEP_EVERY_MS = HOUR_MS;

/**
 * How old a private copy must be, by Pinata's own upload time, before a missing passport is read as
 * abandoned (ruling D5). A creator signs and registers minutes after /prepare, so two days is far
 * past any registration still in flight and past any RPC that lags behind the chain.
 */
export const SWEEP_MIN_AGE_MS = 48 * HOUR_MS;

const THUMBNAIL_PREFIX = "sealed-thumb-";

/**
 * The only names the sweep ever acts on: the whole name, the passport id in the lower case hex
 * /prepare writes. Anything else under the prefix, `.jpg.exe` or capitals included, is skipped and
 * counted, never deleted.
 */
const THUMBNAIL_NAME = /^sealed-thumb-(0x[0-9a-f]{64})\.jpg$/;

/** Pinata's upload time, read only when it is a full ISO date and time with a zone. */
const createdAtSchema = z.iso.datetime({ offset: true });

export interface SweepCounts {
  /** Rows the listing handed back under the prefix. */
  listed: number;
  /** Rows whose name is not exactly a thumbnail name. */
  oddNames: number;
  /** Rows whose upload time was missing or not a date. */
  undated: number;
  /** Rows 48 hours old or younger. */
  young: number;
  /** Rows whose passport the chain holds. */
  registered: number;
  /** Rows whose passport the chain said does not exist: logged in dry, deleted in delete. */
  marked: number;
  deleted: number;
  failed: number;
}

export interface SweepRun {
  /** When the run started, ISO. */
  at: string;
  mode: "dry" | "delete";
  /** "stopped" is a listing it could not finish or a chain read that failed: nothing was marked. */
  outcome: "finished" | "stopped";
  /** The listing stopped at its page or row bound, so the account may hold more than was read. */
  more: boolean;
  counts: SweepCounts;
}

export interface SweepDeps {
  list: () => Promise<{ files: PrivateListing[]; more: boolean }>;
  /** True when the chain holds the passport, false only when it answered that it does not. Throws otherwise. */
  registered: (passportId: Hex) => Promise<boolean>;
  remove: (fileId: string) => Promise<void>;
  now: () => number;
}

export type SweepLog = Pick<FastifyBaseLogger, "info" | "warn" | "error">;

export interface PrivateSweep {
  mode: PrivateSweepMode;
  /**
   * One run. Never rejects. Resolves undefined without touching anything when the mode is off or
   * another run is still going, so two runs never overlap.
   */
  runOnce: () => Promise<SweepRun | undefined>;
  /** Schedules the first run an hour from now and one every hour after. Hands back the stop. */
  start: () => () => void;
  /** What /health shows: the mode and the last run, with no file id, link or reason in it. */
  state: () => { mode: PrivateSweepMode; lastRun: SweepRun | null };
}

/**
 * The hourly sweep of private copies whose passport never reached the chain (B9, B15, D5).
 *
 * /prepare keeps a private thumbnail before the creator signs, so a creator who walks away leaves
 * one behind under a passport id nobody registered. Each run lists at most 10 pages and 200 files
 * under the prefix, keeps only exact thumbnail names uploaded more than 48 hours ago, asks the
 * registry about each id, and marks a file only when the chain answered that the passport does
 * not exist. An RPC error, a listing it could not finish, or any answer it does not know ends the
 * run with nothing marked: deletion cannot be undone, so every doubt keeps the file. In dry it logs
 * each file it would delete by name and age; in delete it deletes them. Both log the counts.
 */
export function privateSweep(options: {
  mode: PrivateSweepMode;
  log: SweepLog;
  deps?: Partial<SweepDeps>;
}): PrivateSweep {
  const mode = options.mode;
  const log = options.log;
  const deps: SweepDeps = {
    list: options.deps?.list ?? liveListing,
    registered: options.deps?.registered ?? liveRegistration(),
    remove: options.deps?.remove ?? deletePrivateFile,
    now: options.deps?.now ?? ((): number => Date.now()),
  };
  let running = false;
  let lastRun: SweepRun | null = null;

  const sweep = async (active: "dry" | "delete"): Promise<SweepRun> => {
    const started = deps.now();
    const counts: SweepCounts = {
      listed: 0,
      oddNames: 0,
      undated: 0,
      young: 0,
      registered: 0,
      marked: 0,
      deleted: 0,
      failed: 0,
    };
    const run = (outcome: SweepRun["outcome"], more: boolean): SweepRun => ({
      at: new Date(started).toISOString(),
      mode: active,
      outcome,
      more,
      counts,
    });

    let listing: { files: PrivateListing[]; more: boolean };
    try {
      listing = await deps.list();
    } catch (error) {
      log.warn({ mode: active, reason: reasonOf(error) }, "sweep: stopped, the private listing could not finish, nothing marked");
      return run("stopped", false);
    }

    const byPassport = new Map<Hex, { file: PrivateListing; ageHours: number }[]>();
    for (const file of listing.files) {
      counts.listed += 1;
      const match = THUMBNAIL_NAME.exec(file.name);
      const id = match?.[1] as Hex | undefined;
      if (id === undefined || privateThumbnailName(id) !== file.name) {
        counts.oddNames += 1;
        continue;
      }
      const created = uploadedAt(file.createdAt);
      if (created === undefined) {
        counts.undated += 1;
        continue;
      }
      const age = started - created;
      if (age <= SWEEP_MIN_AGE_MS) {
        counts.young += 1;
        continue;
      }
      const group = byPassport.get(id) ?? [];
      group.push({ file, ageHours: Math.floor(age / HOUR_MS) });
      byPassport.set(id, group);
    }

    const marked: { file: PrivateListing; ageHours: number }[] = [];
    for (const [id, group] of byPassport) {
      let held: boolean;
      try {
        held = await deps.registered(id);
      } catch (error) {
        log.warn(
          { mode: active, passportId: id, reason: reasonOf(error) },
          "sweep: stopped, the chain did not answer for a passport, nothing marked",
        );
        return run("stopped", listing.more);
      }
      if (held === false) {
        marked.push(...group);
      } else {
        counts.registered += group.length;
      }
    }
    counts.marked = marked.length;

    if (active === "dry") {
      for (const { file, ageHours } of marked) {
        log.info({ name: file.name, ageHours }, "sweep (dry): would delete a private copy whose passport never registered");
      }
      log.info({ mode: active, more: listing.more, ...counts }, "sweep (dry): run finished, nothing deleted");
      return run("finished", listing.more);
    }

    // Bounded by the listing's own 200 row cap.
    for (const { file, ageHours } of marked) {
      try {
        await deps.remove(file.id);
        counts.deleted += 1;
        log.info({ name: file.name, ageHours }, "sweep: deleted a private copy whose passport never registered");
      } catch (error) {
        counts.failed += 1;
        log.error({ name: file.name, reason: reasonOf(error) }, "sweep: could not delete a private copy");
      }
    }
    log.info({ mode: active, more: listing.more, ...counts }, "sweep: run finished");
    return run("finished", listing.more);
  };

  const runOnce = async (): Promise<SweepRun | undefined> => {
    if (mode === "off") {
      return undefined;
    }
    if (running) {
      log.warn({ mode }, "sweep: the last run is still going, this one is skipped");
      return undefined;
    }
    running = true;
    try {
      const result = await sweep(mode);
      lastRun = result;
      return result;
    } catch (error) {
      // Every step above catches its own failures; this is the belt for one nobody foresaw.
      log.error({ mode, reason: reasonOf(error) }, "sweep: stopped on an unexpected error, nothing more done");
      return undefined;
    } finally {
      running = false;
    }
  };

  return {
    mode,
    runOnce,
    start: () => {
      if (mode === "off") {
        return () => undefined;
      }
      let every: ReturnType<typeof setInterval> | undefined;
      const first = setTimeout(() => {
        void runOnce();
        every = setInterval(() => {
          void runOnce();
        }, SWEEP_EVERY_MS);
        every.unref();
      }, SWEEP_FIRST_RUN_MS);
      // A sweep that is only waiting for its hour must not keep the process alive.
      first.unref();
      return () => {
        clearTimeout(first);
        if (every !== undefined) clearInterval(every);
      };
    },
    state: () => ({ mode, lastRun }),
  };
}

/** Pinata's created_at in milliseconds, or undefined for anything that is not a full ISO date and time. */
function uploadedAt(createdAt: string | undefined): number | undefined {
  if (!createdAtSchema.safeParse(createdAt).success) {
    return undefined;
  }
  const at = Date.parse(createdAt as string);
  return Number.isFinite(at) ? at : undefined;
}

async function liveListing(): Promise<{ files: PrivateListing[]; more: boolean }> {
  return await listPrivateByPrefix(THUMBNAIL_PREFIX, {
    maxPages: PRIVATE_PREFIX_MAX_PAGES,
    maxFiles: PRIVATE_PREFIX_MAX_FILES,
  });
}

/**
 * Whether the registry holds a passport, read straight from getPassport.
 *
 * Only a `registeredAt` that is the bigint zero means "does not exist", which is the registry's own
 * rule for an unknown id. Any other shape throws rather than being read as zero, so an answer this
 * code does not know can never turn into a deletion.
 */
function liveRegistration(): (passportId: Hex) => Promise<boolean> {
  const chain = readClient();
  const registry = env.MOOLAM_REGISTRY_ADDRESS as Hex;
  return async (passportId) => {
    const record: unknown = await chain.readContract({
      address: registry,
      abi: registryUnsealAbi,
      functionName: "getPassport",
      args: [passportId],
    });
    const registeredAt = (record as { registeredAt?: unknown } | null)?.registeredAt;
    if (typeof registeredAt !== "bigint") {
      throw new Error("the registry answered getPassport in a shape the sweep does not know");
    }
    return registeredAt !== 0n;
  };
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
