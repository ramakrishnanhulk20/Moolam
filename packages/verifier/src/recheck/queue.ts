import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { safeReason } from "../net/errorText.js";
import type { Hex } from "../types.js";

/**
 * The most requests the queue will hold, counting every state.
 *
 * The file is rewritten whole on every change, so this is what keeps that write small and what
 * bounds the memory of a service anyone may add to. Finished requests are dropped to make room and
 * a waiting one never is, so reaching this number means a thousand real requests nobody has run.
 */
export const MAX_ITEMS = 1000;

/**
 * How long a finished request stays readable.
 *
 * A week is far longer than anyone waits for an answer and short enough that the file stays small.
 * After that the passport's re-check lives on the chain, which is the record that matters; this
 * queue only ever remembered who asked for it.
 */
export const KEEP_FINISHED_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long a claimed request may sit in "running" before another runner may take it, and before
 * the queue offers it and reads it as pending again.
 *
 * A simulation is given ten minutes by the runner itself, so thirty means the runner is gone, not
 * slow. Re-claiming an abandoned request is safe: the worst case is one duplicate second opinion.
 */
export const CLAIM_TIMEOUT_MS = 30 * 60 * 1000;

/** A failure reason is cut to this, because it is written by a runner and read by strangers. */
export const REASON_MAX_CHARS = 200;

/** What the queue file calls itself, so a file from another shape is refused rather than misread. */
export const QUEUE_FILE_VERSION = 1;

export type RecheckStatus = "pending" | "running" | "done" | "failed";

/**
 * One request for a Chainlink second opinion.
 *
 * Every time is unix milliseconds, which is what the runner compares ages against and what this
 * module's own ceilings are counted in. Nothing here names the caller: asking for a re-check costs
 * nothing and needs no account, so there is no identity worth keeping.
 */
export interface RecheckItem {
  passportId: Hex;
  status: RecheckStatus;
  requestedAt: number;
  requestedBy: "public";
  startedAt?: number;
  finishedAt?: number;
  /** The transaction the runner's report landed in, which is what makes a request "done". */
  reportTx?: string;
  matched?: boolean;
  distance?: number;
  reason?: string;
}

const PASSPORT_ID = /^0x[0-9a-f]{64}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

/**
 * The stored shape, read loosely on purpose: unknown keys are dropped rather than refused, so a
 * file written by a later version still loads the requests both versions understand.
 */
const itemSchema = z.object({
  passportId: z.string().regex(PASSPORT_ID),
  status: z.enum(["pending", "running", "done", "failed"]),
  requestedAt: z.number().int().nonnegative(),
  requestedBy: z.literal("public"),
  startedAt: z.number().int().nonnegative().optional(),
  finishedAt: z.number().int().nonnegative().optional(),
  reportTx: z.string().regex(TX_HASH).optional(),
  matched: z.boolean().optional(),
  distance: z.number().int().nonnegative().optional(),
  reason: z.string().max(REASON_MAX_CHARS).optional(),
});

const fileSchema = z.object({
  version: z.literal(QUEUE_FILE_VERSION),
  items: z.array(itemSchema),
});

/** What a store hands back, with a line to log when the file was missing or could not be read. */
export interface StoredQueue {
  items: RecheckItem[];
  note?: string;
}

export interface QueueStore {
  read(): StoredQueue;
  /** Throws when the queue could not be saved. The caller keeps serving from memory and says so. */
  write(items: readonly RecheckItem[]): void;
}

/** A store that keeps nothing, for tests and for a host that has nowhere to write. */
export function memoryQueueStore(items: RecheckItem[] = []): QueueStore {
  let held = items.map((item) => ({ ...item }));
  return {
    read: () => ({ items: held.map((item) => ({ ...item })) }),
    write: (next) => {
      held = next.map((item) => ({ ...item }));
    },
  };
}

export interface FileStoreOptions {
  /**
   * Swapped in tests to stop between the temp file and the rename, which is the crash this store
   * exists to survive.
   */
  rename?: (from: string, to: string) => void;
}

/**
 * The queue as a JSON file, rewritten whole and swapped into place.
 *
 * The write goes to a temp name and is renamed over the real one, so a process killed mid-write
 * leaves the previous file untouched rather than half a file that loads as nothing. The temp name
 * is fixed rather than unique because this service runs as one instance and there is exactly one
 * writer; a second copy of the service would need its own path.
 *
 * Nothing here is fsynced. A crash in the seconds after a rename can still lose the newest
 * request, and that is the right trade for a queue anyone may add to again for free.
 */
export function fileQueueStore(filePath: string, options: FileStoreOptions = {}): QueueStore {
  const rename = options.rename ?? renameSync;
  const temp = `${filePath}.tmp`;

  return {
    read: () => {
      let text: string;
      try {
        text = readFileSync(filePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return { items: [], note: `no re-check queue file at ${filePath} yet, starting empty` };
        }
        return { items: [], note: `the re-check queue at ${filePath} could not be read, starting empty` };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return { items: [], note: `the re-check queue at ${filePath} is not JSON, starting empty` };
      }

      const result = fileSchema.safeParse(parsed);
      if (!result.success) {
        return { items: [], note: `the re-check queue at ${filePath} is not a queue this version reads, starting empty` };
      }
      return { items: result.data.items as RecheckItem[] };
    },

    write: (items) => {
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(temp, `${JSON.stringify({ version: QUEUE_FILE_VERSION, items }, null, 2)}\n`, "utf8");
      rename(temp, filePath);
    },
  };
}

export type RequestOutcome =
  | { ok: true; item: RecheckItem; already: boolean; position: number }
  | { ok: false; refused: "queue-full" };

export type ClaimOutcome =
  | { ok: true; item: RecheckItem; reclaimed: boolean }
  | { ok: false; refused: "no-request" | "already-running" | "not-pending" };

export type FinishOutcome = { ok: true; item: RecheckItem } | { ok: false; refused: "no-request" | "not-running" };

export interface FinishInput {
  reportTx?: string;
  matched?: boolean;
  distance?: number;
  reason?: string;
}

export interface RecheckQueue {
  /** Records a request, or hands back the one already waiting or running for this passport. */
  request: (passportId: Hex) => RequestOutcome;
  status: (passportId: Hex) => RecheckItem | undefined;
  /** The oldest waiting requests, a claim past the timeout among them, at most `limit`, marking nothing. */
  pending: (limit: number) => RecheckItem[];
  claim: (passportId: Hex) => ClaimOutcome;
  /**
   * Whether a runner holds this passport's request right now and claimed it less than `windowMs`
   * ago, by this queue's own clock. Pending, answered and unknown requests are all false.
   */
  claimedWithin: (passportId: Hex, windowMs: number) => boolean;
  finish: (passportId: Hex, outcome: FinishInput) => FinishOutcome;
  counts: () => { pending: number; running: number };
  /** Everything held, newest last, for the health line and for tests. */
  all: () => RecheckItem[];
}

export interface RecheckQueueOptions {
  store?: QueueStore;
  now?: () => number;
  maxItems?: number;
  keepFinishedMs?: number;
  claimTimeoutMs?: number;
  /** Where the boot note and a failed save are reported. Silent by default. */
  log?: (line: string) => void;
}

/**
 * The re-check queue: a handful of requests in memory with a file behind them.
 *
 * It is a module rather than a table because a request is worth almost nothing. Losing the file
 * costs the world one press of a button, and a database for that would be a second thing to run,
 * to pay for and to lock the service's boot on.
 *
 * The map is the queue order. A request is appended, and a passport asked for again after its last
 * answer is moved to the back rather than edited in place, so "oldest first" needs no sort and two
 * requests in the same millisecond keep the order they arrived in.
 *
 * A save that fails is logged and swallowed: a host with nowhere to write still takes requests and
 * still hands them to the runner, it just forgets them on a redeploy.
 */
export function recheckQueue(options: RecheckQueueOptions = {}): RecheckQueue {
  const store = options.store ?? memoryQueueStore();
  const now = options.now ?? Date.now;
  const maxItems = options.maxItems ?? MAX_ITEMS;
  const keepFinishedMs = options.keepFinishedMs ?? KEEP_FINISHED_MS;
  const claimTimeoutMs = options.claimTimeoutMs ?? CLAIM_TIMEOUT_MS;
  const log = options.log ?? ((): void => {});

  const loaded = store.read();
  if (loaded.note !== undefined) {
    log(loaded.note);
  }
  const items = new Map<Hex, RecheckItem>(loaded.items.map((item) => [item.passportId.toLowerCase() as Hex, item]));

  let saveFailed = false;
  const save = (): void => {
    try {
      store.write([...items.values()]);
      saveFailed = false;
    } catch (error) {
      if (!saveFailed) {
        // Said once per run of failures rather than once per request, so a read-only disk does not
        // fill the log with the same line on every button press.
        log(`the re-check queue could not be saved, holding it in memory only: ${safeReason(error)}`);
        saveFailed = true;
      }
    }
  };

  const finished = (item: RecheckItem): boolean => item.status === "done" || item.status === "failed";

  /**
   * A claim nobody closed within claimTimeoutMs: the runner that took it is gone, or its done never
   * arrived. It reads as pending everywhere a caller or a runner looks, so the passport is offered
   * again and anyone may ask for it again (review pass 4, V19). What is stored stays "running", so
   * the claim that picks it up still reports itself as a reclaim.
   */
  const abandoned = (item: RecheckItem): boolean =>
    item.status === "running" && now() - (item.startedAt ?? 0) > claimTimeoutMs;

  const waiting = (item: RecheckItem): boolean => item.status === "pending" || abandoned(item);

  /** The item as a reader sees it: an abandoned claim is a pending request with no start time. */
  const seen = (item: RecheckItem): RecheckItem => {
    if (!abandoned(item)) {
      return { ...item };
    }
    const reopened: RecheckItem = { ...item, status: "pending" };
    delete reopened.startedAt;
    return reopened;
  };

  /**
   * Drops what has aged out, then the oldest answered requests until `target` is met.
   *
   * A request that is waiting or running is never dropped, so a queue full of real work stays full
   * and the route refuses the next caller instead. The target is one below the cap when a new
   * request is about to be added, which is how room is made for it.
   */
  const prune = (target = maxItems): number => {
    const cutoff = now() - keepFinishedMs;
    let dropped = 0;
    for (const [id, item] of items) {
      if (finished(item) && (item.finishedAt ?? item.requestedAt) <= cutoff) {
        items.delete(id);
        dropped += 1;
      }
    }
    for (const [id, item] of items) {
      if (items.size <= target) {
        break;
      }
      if (finished(item)) {
        items.delete(id);
        dropped += 1;
      }
    }
    return dropped;
  };

  // Reads prune too, so a request that aged out reads as "nobody asked" even on a service nobody
  // has written to for a week. The file is only rewritten when something was actually dropped.
  const pruneOnRead = (): void => {
    if (prune() > 0) {
      save();
    }
  };

  const positionOf = (passportId: Hex): number => {
    let place = 0;
    for (const item of items.values()) {
      if (waiting(item)) {
        place += 1;
        if (item.passportId === passportId) {
          return place;
        }
      }
    }
    return 0;
  };

  return {
    request: (passportId) => {
      const id = passportId.toLowerCase() as Hex;
      const held = items.get(id);
      if (held !== undefined && !finished(held)) {
        pruneOnRead();
        return { ok: true, item: seen(held), already: true, position: positionOf(id) };
      }

      prune(maxItems - 1);
      if (!items.has(id) && items.size >= maxItems) {
        return { ok: false, refused: "queue-full" };
      }

      const item: RecheckItem = {
        passportId: id,
        status: "pending",
        requestedAt: now(),
        requestedBy: "public",
      };
      // Deleted first so a passport asked for again after its last answer joins the back of the
      // queue instead of keeping the place its old request held.
      items.delete(id);
      items.set(id, item);
      save();
      return { ok: true, item: { ...item }, already: false, position: positionOf(id) };
    },

    status: (passportId) => {
      pruneOnRead();
      const held = items.get(passportId.toLowerCase() as Hex);
      return held === undefined ? undefined : seen(held);
    },

    pending: (limit) => {
      pruneOnRead();
      const offered: RecheckItem[] = [];
      for (const item of items.values()) {
        if (offered.length >= limit) {
          break;
        }
        if (waiting(item)) {
          offered.push(seen(item));
        }
      }
      return offered;
    },

    claim: (passportId) => {
      const id = passportId.toLowerCase() as Hex;
      const held = items.get(id);
      if (held === undefined) {
        return { ok: false, refused: "no-request" };
      }
      if (finished(held)) {
        return { ok: false, refused: "not-pending" };
      }
      const reclaimed = abandoned(held);
      if (held.status === "running" && !reclaimed) {
        return { ok: false, refused: "already-running" };
      }

      const claimed: RecheckItem = { ...held, status: "running", startedAt: now() };
      items.set(id, claimed);
      save();
      return { ok: true, item: { ...claimed }, reclaimed };
    },

    claimedWithin: (passportId, windowMs) => {
      const held = items.get(passportId.toLowerCase() as Hex);
      if (held === undefined || held.status !== "running" || held.startedAt === undefined) {
        return false;
      }
      // A claim stamped in the future is a clock that stepped back, and doubt refuses.
      const age = now() - held.startedAt;
      return age >= 0 && age < windowMs;
    },

    finish: (passportId, outcome) => {
      const id = passportId.toLowerCase() as Hex;
      const held = items.get(id);
      if (held === undefined) {
        return { ok: false, refused: "no-request" };
      }
      if (held.status !== "running") {
        return { ok: false, refused: "not-running" };
      }

      // A report transaction is the whole point of a re-check, so it is what decides the verdict:
      // without one the run failed, whatever else the runner sent.
      const done = outcome.reportTx !== undefined;
      const item: RecheckItem = {
        ...held,
        status: done ? "done" : "failed",
        finishedAt: now(),
        reportTx: outcome.reportTx,
        matched: outcome.matched,
        distance: outcome.distance,
        reason: outcome.reason === undefined ? undefined : outcome.reason.slice(0, REASON_MAX_CHARS),
      };
      items.set(id, item);
      prune();
      save();
      return { ok: true, item: { ...item } };
    },

    counts: () => {
      pruneOnRead();
      let pending = 0;
      let running = 0;
      for (const item of items.values()) {
        if (waiting(item)) pending += 1;
        else if (item.status === "running") running += 1;
      }
      return { pending, running };
    },

    all: () => {
      pruneOnRead();
      return [...items.values()].map((item) => ({ ...item }));
    },
  };
}
