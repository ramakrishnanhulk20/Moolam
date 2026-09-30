import { readFileSync } from "node:fs";
import { z } from "zod";
import { safeReason } from "../net/errorText.js";
import { writeJsonFile } from "../stateDir.js";

/**
 * One PlatformPrepare this service accepted: which platform, its nonce, the picture it named, and
 * the chain time after which its signature is outside the window and a replay fails on time alone.
 */
export interface SeenPrepare {
  platform: string;
  nonce: string;
  picture: string;
  expiresAt: number;
}

export type StoredNonces =
  | { kind: "none" }
  | { kind: "record"; seen: SeenPrepare[] }
  | { kind: "refused"; note: string };

export interface NonceStore {
  read: () => StoredNonces;
  /** Throws when the list could not be saved. */
  write: (seen: SeenPrepare[]) => void;
}

export const NONCE_FILE_VERSION = 1;

/**
 * Far past what the daily quotas can add inside one ten-minute window. A full list refuses the next
 * prepare rather than forgetting a nonce that is still inside its window.
 */
export const MAX_REMEMBERED = 20_000;

const bytes32 = z.string().regex(/^0x[0-9a-f]{64}$/);

const nonceFileSchema = z.strictObject({
  version: z.literal(NONCE_FILE_VERSION),
  seen: z
    .array(
      z.strictObject({
        platform: bytes32,
        nonce: bytes32,
        picture: bytes32,
        expiresAt: z.number().int().nonnegative(),
      }),
    )
    .max(MAX_REMEMBERED),
});

export function memoryNonceStore(): NonceStore {
  let held: SeenPrepare[] | undefined;
  return {
    read: () => (held === undefined ? { kind: "none" } : { kind: "record", seen: held.map((one) => ({ ...one })) }),
    write: (seen) => {
      held = seen.map((one) => ({ ...one }));
    },
  };
}

/** The list as one JSON file, written through writeJsonFile. A file that cannot be believed is refused. */
export function fileNonceStore(filePath: string): NonceStore {
  return {
    read: () => {
      let text: string;
      try {
        text = readFileSync(filePath, "utf8");
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT"
          ? { kind: "none" }
          : { kind: "refused", note: `the nonce file at ${filePath} could not be read` };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return { kind: "refused", note: `the nonce file at ${filePath} is not JSON` };
      }
      const result = nonceFileSchema.safeParse(parsed);
      return result.success
        ? { kind: "record", seen: result.data.seen }
        : { kind: "refused", note: `the nonce file at ${filePath} is not a record this version reads` };
    },
    write: (seen) => {
      writeJsonFile(filePath, { version: NONCE_FILE_VERSION, seen });
    },
  };
}

export type NonceVerdict = { ok: true } | { ok: false; reason: "replayed" | "same-picture" | "closed" | "full" };

export interface NonceMemory {
  /**
   * Remembers this PlatformPrepare, or says why it cannot be accepted: its nonce, or its picture,
   * was already accepted for this platform inside the window, the memory is closed after a file it
   * could not believe, or it is full. Nothing awaits, so two requests cannot both pass one check.
   */
  accept: (seen: SeenPrepare, chainNow: bigint) => NonceVerdict;
}

/**
 * The replay memory for PlatformPrepare messages, kept in the data folder so a restart does not
 * make every nonce of the last ten minutes usable again.
 *
 * A saved file that cannot be believed is refused, and every prepare is refused for one window from
 * the boot, after which nothing it could have held is still inside a signature's window. A save that
 * fails keeps the memory in this process and says so once.
 */
export function nonceMemory(
  store: NonceStore,
  options: { log?: (line: string) => void; clockMs?: () => number } = {},
): NonceMemory {
  const log = options.log ?? ((): void => {});
  const clockMs = options.clockMs ?? Date.now;
  const loaded = store.read();
  let seen: SeenPrepare[] = loaded.kind === "record" ? loaded.seen : [];
  let closedUntilMs: number | undefined;
  if (loaded.kind === "refused") {
    closedUntilMs = clockMs() + 600_000;
    log(`${loaded.note}, so every platform prepare is refused for ten minutes`);
  }

  let saveFailed = false;
  const save = (): void => {
    try {
      store.write(seen);
      saveFailed = false;
    } catch (error) {
      if (!saveFailed) {
        log(`the platform nonce memory could not be saved, keeping it in memory only: ${safeReason(error)}`);
        saveFailed = true;
      }
    }
  };

  return {
    accept(next, chainNow) {
      if (closedUntilMs !== undefined && clockMs() < closedUntilMs) {
        return { ok: false, reason: "closed" };
      }
      const now = Number(chainNow);
      seen = seen.filter((one) => one.expiresAt >= now);
      for (const one of seen) {
        if (one.platform !== next.platform) continue;
        if (one.nonce === next.nonce) return { ok: false, reason: "replayed" };
        if (one.picture === next.picture) return { ok: false, reason: "same-picture" };
      }
      if (seen.length >= MAX_REMEMBERED) {
        return { ok: false, reason: "full" };
      }
      seen.push({ ...next });
      save();
      return { ok: true };
    },
  };
}
