import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { env, type DataDirSource } from "./env.js";

/**
 * The files this service keeps in its data folder, by what they remember. Everything the service
 * promises to remember across a deploy is in this list or in the re-check queue's own file.
 */
export const STATE_FILES = {
  keepTimes: "private-copy-kept.json",
  sweepCursor: "private-sweep-cursor.json",
  dayCeilings: "global-day.json",
  generateQuota: "quota-generate.json",
  editQuota: "quota-edit.json",
  unsealQuota: "quota-unseal.json",
  webCheckDay: "web-check-day.json",
  challengeAnswers: "challenge-answers.json",
  decisionReasons: "decision-reasons.json",
  decisionReasonsDay: "decision-reasons-day.json",
} as const;

/**
 * What the platform routes keep in the same data folder. Held apart from STATE_FILES because
 * `pending` is a folder, one JSON record per co-sign handle with the frozen files beside it, not one
 * file, and each of these has its own restart test in test/platform-state.test.ts.
 */
export const PLATFORM_STATE_FILES = {
  quota: "platform-quota.json",
  dayCeiling: "platform-day.json",
  nonces: "platform-nonces.json",
  pending: "platform-pending",
} as const;

/**
 * What the claim routes keep. `tickets` is one file holding every ticket, standing destination,
 * mute and per-key refusal tally, so a step that touches several of them is one write; the other
 * three are the per-person meters, each with its own restart behaviour like the files above.
 */
export const CLAIM_STATE_FILES = {
  tickets: "claim-tickets.json",
  userQuota: "claim-quota-user.json",
  addressQuota: "claim-quota-address.json",
  dayCeiling: "claim-day.json",
} as const;

export interface FolderCheck {
  dir: string;
  writable: boolean;
  /** Why it is not writable: the error code only, never a message that could carry more. */
  reason?: string;
}

/**
 * Whether this process can keep files in `dir` the way every store here keeps them: create the
 * folder, write a temp file and rename it into place. Anything short of the rename is not good
 * enough, because a folder that takes the write and refuses the rename loses every save.
 */
export function probeFolder(dir: string): FolderCheck {
  const probe = path.join(dir, `.write-probe-${process.pid}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${probe}.tmp`, "ok\n", "utf8");
    renameSync(`${probe}.tmp`, probe);
    rmSync(probe, { force: true });
    return { dir, writable: true };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { dir, writable: false, reason: typeof code === "string" ? code : "unknown error" };
  }
}

/**
 * Writes `value` as JSON under a temp name and renames it over `filePath`, so a process killed
 * mid-write leaves the previous file whole. The same pattern and the same trade as the re-check
 * queue's file: one writer, a fixed temp name, no fsync. Throws when the folder cannot be written.
 */
export function writeJsonFile(
  filePath: string,
  value: unknown,
  rename: (from: string, to: string) => void = renameSync,
): void {
  const temp = `${filePath}.tmp`;
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(temp, `${JSON.stringify(value)}\n`, "utf8");
  rename(temp, filePath);
}

export interface StateFolders {
  /** The folder every state file lives in. */
  dataDir: string;
  /** The re-check queue's file, which RECHECK_QUEUE_PATH may put somewhere else. */
  queuePath: string;
  source: DataDirSource;
  production: boolean;
}

/**
 * The boot check on where state is kept (platform kit step 0).
 *
 * In production a folder that cannot be written stops the boot with one line naming it, because a
 * service that silently forgets its ceilings and quotas on every deploy is the failure this check
 * exists to end. Anywhere else it warns once and the stores hold everything in memory. A production
 * host whose folder is only the image's own disk is told, once, that its state will not outlive a
 * deploy.
 *
 * Returns which of the two folders can be written. Throws in production when either cannot.
 */
export function openStateFolders(
  folders: StateFolders,
  warn: (line: string) => void,
  probe: (dir: string) => FolderCheck = probeFolder,
): { data: boolean; queue: boolean } {
  const queueDir = path.dirname(folders.queuePath);
  const data = probe(folders.dataDir);
  const queue = queueDir === folders.dataDir ? data : probe(queueDir);

  for (const check of data === queue ? [data] : [data, queue]) {
    if (check.writable) continue;
    if (folders.production) {
      throw new Error(
        `the data folder ${check.dir} cannot be written (${check.reason ?? "unknown error"}): the service will not start without somewhere to keep its ceilings, quotas and queue. Mount a volume there and let the start script hand it to the node user`,
      );
    }
    warn(
      `the data folder ${check.dir} cannot be written (${check.reason ?? "unknown error"}), so what would be kept there is held in memory only and forgotten when the process stops`,
    );
  }

  if (folders.production && folders.source === "default" && data.writable) {
    warn(
      `no DATA_DIR and no Railway volume is set, so state is kept at ${folders.dataDir} on the image's own disk and every deploy starts it empty`,
    );
  }
  return { data: data.writable, queue: queue.writable };
}

const checked = new Map<string, boolean>();

function writable(dir: string): boolean {
  let known = checked.get(dir);
  if (known === undefined) {
    known = probeFolder(dir).writable;
    checked.set(dir, known);
  }
  return known;
}

/**
 * Where a state file lives on this host, or undefined when it is to be held in memory: always under
 * a test runner, so no unit suite leaves a file behind or shares one between two servers, and on a
 * development host whose folder cannot be written, which the boot check has already said.
 */
export function stateFile(name: string): string | undefined {
  if (env.NODE_ENV === "test" || !writable(env.DATA_DIR)) {
    return undefined;
  }
  return path.join(env.DATA_DIR, name);
}

/** The re-check queue's file on this host, or undefined when the queue is to be held in memory. */
export function queueFile(): string | undefined {
  if (env.NODE_ENV === "test" || !writable(path.dirname(env.RECHECK_QUEUE_PATH))) {
    return undefined;
  }
  return env.RECHECK_QUEUE_PATH;
}

/** Runs the boot check against this host's own settings. See openStateFolders. */
export function openHostStateFolders(warn: (line: string) => void): void {
  const result = openStateFolders(
    {
      dataDir: env.DATA_DIR,
      queuePath: env.RECHECK_QUEUE_PATH,
      source: env.DATA_DIR_SOURCE,
      production: env.NODE_ENV === "production",
    },
    warn,
  );
  // The probe the boot just ran is the answer every store asks for later, so a folder cannot read
  // as writable to one store and not to another.
  checked.set(env.DATA_DIR, result.data);
  checked.set(path.dirname(env.RECHECK_QUEUE_PATH), result.queue);
}
