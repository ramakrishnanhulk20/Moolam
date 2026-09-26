import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";
import { env, type PrivateSweepMode } from "./env.js";
import { PRIVATE_SWEEP_PAGES, deletePrivateFile, listPrivatePage, type PrivateListing } from "./ipfs/pinata.js";
import { safeReason } from "./net/errorText.js";
import { readClient } from "./reputation/registry.js";
import { privateRecheckFor, privateThumbnailName } from "./sealed.js";
import type { Hex } from "./types.js";
import { readMetadataDocument, registryUnsealAbi } from "./unseal.js";

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

/**
 * The only names the sweep ever acts on: the whole name, the passport id in the lower case hex
 * /prepare writes. Anything else under the prefix, `.jpg.exe` or capitals included, is skipped and
 * counted, never deleted.
 */
const THUMBNAIL_NAME = /^sealed-thumb-(0x[0-9a-f]{64})\.jpg$/;

/** Pinata's upload time, read only when it is a full ISO date and time with a zone. */
const createdAtSchema = z.iso.datetime({ offset: true });

export interface SweepCounts {
  /** Rows the listing handed back this run. */
  listed: number;
  /** Rows whose name is not exactly a thumbnail name. */
  oddNames: number;
  /** Rows whose upload time was missing or not a date. */
  undated: number;
  /** Rows 48 hours old or younger. */
  young: number;
  /** Rows whose passport the chain holds and whose document asks for the copy, or cannot be read. */
  registered: number;
  /**
   * Rows whose passport the chain said does not exist, or holds under a document that does not ask
   * for a private re-check of it: logged in dry, deleted in delete.
   */
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
  /** The listing stopped at its page bound, so the next run goes on from there. */
  more: boolean;
  counts: SweepCounts;
}

export interface SweepDeps {
  /** A few pages of the private listing from `from`, or from the first page, and where to go on from. */
  list: (from: string | undefined) => Promise<{ files: PrivateListing[]; next: string | undefined }>;
  /** True when the chain holds the passport, false only when it answered that it does not. Throws otherwise. */
  registered: (passportId: Hex) => Promise<boolean>;
  /** A registered passport's metadata document. Throws when it cannot be read. */
  document: (passportId: Hex) => Promise<unknown>;
  remove: (fileId: string) => Promise<void>;
  now: () => number;
  /** Where the place the listing stopped is kept between runs and across a restart. */
  cursor: CursorStore;
}

/**
 * The sweep's place in the listing: Pinata's page token, or undefined for the first page.
 * `write` may throw; the sweep keeps its place in memory and says so once.
 */
export interface CursorStore {
  read: () => string | undefined;
  write: (next: string | undefined) => void;
}

/** What the cursor file calls itself, so a file of another shape is read as the first page. */
const CURSOR_FILE_VERSION = 1;

/**
 * A page token is Pinata's opaque string. It goes back to Pinata as a query value and nowhere
 * else, so one that is not short printable text with no spaces is not believed and the sweep
 * starts at the first page, which costs a run and never a file.
 */
const PAGE_TOKEN = /^[\x21-\x7e]{1,512}$/;

const cursorFileSchema = z.object({
  version: z.literal(CURSOR_FILE_VERSION),
  next: z.string().regex(PAGE_TOKEN).nullable(),
});

/** A cursor that lives only as long as the process, for tests and for a host with nowhere to write. */
export function memoryCursorStore(): CursorStore {
  let held: string | undefined;
  return {
    read: () => held,
    write: (next) => {
      held = next;
    },
  };
}

/**
 * The cursor as a small JSON file, written to a temp name and renamed into place the same way the
 * re-check queue's file is, so a process killed mid-write leaves the last good place behind.
 * Anything missing, unreadable or of another shape reads as the first page.
 */
export function fileCursorStore(filePath: string): CursorStore {
  const temp = `${filePath}.tmp`;
  return {
    read: () => {
      try {
        const parsed = cursorFileSchema.safeParse(JSON.parse(readFileSync(filePath, "utf8")));
        return parsed.success ? (parsed.data.next ?? undefined) : undefined;
      } catch {
        return undefined;
      }
    },
    write: (next) => {
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(temp, `${JSON.stringify({ version: CURSOR_FILE_VERSION, next: next ?? null })}\n`, "utf8");
      renameSync(temp, filePath);
    },
  };
}

/**
 * The live cursor file, beside the re-check queue's own file, which is the one place this service
 * already keeps state that survives a redeploy. Under a test runner nothing is written to disk.
 */
function defaultCursorStore(): CursorStore {
  if (env.NODE_ENV === "test") {
    return memoryCursorStore();
  }
  return fileCursorStore(path.join(path.dirname(env.RECHECK_QUEUE_PATH), "private-sweep-cursor.json"));
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
 * one behind under a passport id nobody registered. Each run reads two pages of the private
 * listing, 200 rows, starting where the last run stopped and going back to the first page once
 * the listing ends, so every row is read in turn however many registered copies sit ahead of an
 * orphan (V16). No name filter is sent to Pinata (V8): the whole-name pattern here is the only
 * check. It keeps only exact thumbnail names uploaded more than 48 hours ago, asks the registry
 * about each id, and marks a file when the chain answered that the passport does not exist, or when
 * the passport is registered under a document that does not ask for a private re-check of it
 * (review pass 6, V53): the same file prepared once with the private re-check and once without
 * leaves a copy no route would ever use. A document that cannot be read keeps its file.
 * The place it stopped is kept in a file beside the re-check queue's, so a redeploy goes on from
 * there rather than reading the first pages again; a place that cannot be saved is kept in memory
 * and said once. An RPC error, a listing it could not finish, or any answer it does not know ends
 * the run with nothing marked: deletion cannot be undone, so every doubt keeps the file. In dry it
 * logs each file it would delete by name and age; in delete it deletes them. Both log the counts.
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
    document: options.deps?.document ?? liveDocument(),
    remove: options.deps?.remove ?? deletePrivateFile,
    now: options.deps?.now ?? ((): number => Date.now()),
    cursor: options.deps?.cursor ?? defaultCursorStore(),
  };
  let running = false;
  let lastRun: SweepRun | null = null;
  /** Where the next run's listing starts: Pinata's page token, or undefined for the first page. */
  let cursor: string | undefined = readCursor(deps.cursor);
  let saveFailed = false;

  const moveCursor = (next: string | undefined): void => {
    cursor = next;
    try {
      deps.cursor.write(next);
      saveFailed = false;
    } catch (error) {
      if (!saveFailed) {
        log.warn({ reason: safeReason(error) }, "sweep: its place in the listing could not be saved, keeping it in memory");
        saveFailed = true;
      }
    }
  };

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

    let listing: { files: PrivateListing[]; next: string | undefined };
    try {
      listing = await deps.list(cursor);
    } catch (error) {
      // A saved page token Pinata will not take any more must not stop every run after it.
      moveCursor(undefined);
      log.warn({ mode: active, reason: safeReason(error) }, "sweep: stopped, the private listing could not finish, nothing marked");
      return run("stopped", false);
    }
    const more = listing.next !== undefined;

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

    const marked: { file: PrivateListing; ageHours: number; why: string }[] = [];
    const unasked: Hex[] = [];
    for (const [id, group] of byPassport) {
      let held: boolean;
      try {
        held = await deps.registered(id);
      } catch (error) {
        log.warn(
          { mode: active, passportId: id, reason: safeReason(error) },
          "sweep: stopped, the chain did not answer for a passport, nothing marked",
        );
        return run("stopped", more);
      }
      if (held === false) {
        marked.push(...group.map((one) => ({ ...one, why: "its passport never registered" })));
        continue;
      }
      if (held !== true) {
        counts.registered += group.length;
        continue;
      }
      unasked.push(id);
    }
    // Read only once every chain answer is in, so a run that stops on the chain reads no document.
    for (const id of unasked) {
      const group = byPassport.get(id) ?? [];
      let asks: boolean;
      try {
        asks = privateRecheckFor(await deps.document(id), id) === "asked";
      } catch (error) {
        log.warn({ mode: active, passportId: id, reason: safeReason(error) }, "sweep: a registered passport's document could not be read, its copy stays");
        asks = true;
      }
      if (asks) {
        counts.registered += group.length;
      } else {
        marked.push(...group.map((one) => ({ ...one, why: "its registered passport's document does not ask for it" })));
      }
    }
    counts.marked = marked.length;
    // Every page read this run was decided on, so the next run goes on past them.
    moveCursor(listing.next);

    if (active === "dry") {
      for (const { file, ageHours, why } of marked) {
        log.info({ name: file.name, ageHours }, `sweep (dry): would delete a private copy: ${why}`);
      }
      log.info({ mode: active, more, ...counts }, "sweep (dry): run finished, nothing deleted");
      return run("finished", more);
    }

    // Bounded by the two pages the listing reads: 200 rows.
    for (const { file, ageHours, why } of marked) {
      try {
        await deps.remove(file.id);
        counts.deleted += 1;
        log.info({ name: file.name, ageHours }, `sweep: deleted a private copy: ${why}`);
      } catch (error) {
        counts.failed += 1;
        log.error({ name: file.name, reason: safeReason(error) }, "sweep: could not delete a private copy");
      }
    }
    log.info({ mode: active, more, ...counts }, "sweep: run finished");
    return run("finished", more);
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
      log.error({ mode, reason: safeReason(error) }, "sweep: stopped on an unexpected error, nothing more done");
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

/** The saved place, or the first page when the store itself will not read. */
function readCursor(store: CursorStore): string | undefined {
  try {
    const saved = store.read();
    return saved !== undefined && PAGE_TOKEN.test(saved) ? saved : undefined;
  } catch {
    return undefined;
  }
}

/** Pinata's created_at in milliseconds, or undefined for anything that is not a full ISO date and time. */
function uploadedAt(createdAt: string | undefined): number | undefined {
  if (!createdAtSchema.safeParse(createdAt).success) {
    return undefined;
  }
  const at = Date.parse(createdAt as string);
  return Number.isFinite(at) ? at : undefined;
}

async function liveListing(from: string | undefined): Promise<{ files: PrivateListing[]; next: string | undefined }> {
  return await listPrivatePage(from, PRIVATE_SWEEP_PAGES);
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

/**
 * A registered passport's metadata document: its metadataURI read straight from getPassport, then
 * the document through the same guarded gateway read the routes use. Throws on anything else, which
 * keeps the file.
 */
function liveDocument(): (passportId: Hex) => Promise<unknown> {
  const chain = readClient();
  const registry = env.MOOLAM_REGISTRY_ADDRESS as Hex;
  return async (passportId) => {
    const record: unknown = await chain.readContract({
      address: registry,
      abi: registryUnsealAbi,
      functionName: "getPassport",
      args: [passportId],
    });
    const metadataURI = (record as { metadataURI?: unknown } | null)?.metadataURI;
    if (typeof metadataURI !== "string") {
      throw new Error("the registry answered getPassport in a shape the sweep does not know");
    }
    return await readMetadataDocument(metadataURI);
  };
}
