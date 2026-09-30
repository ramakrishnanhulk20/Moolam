// Covers where the verify service keeps what it must remember (platform kit step 0): the one data
// folder and the order it is chosen in (DATA_DIR, then the Railway volume, then a local folder),
// every state file, the platform's included, resolving directly under that folder, every state
// file surviving a simulated restart, a ceiling file that cannot be believed being
// refused and read as the ceiling already reached, a quota file that cannot be believed closing
// that allowance rather than reopening it, and the boot check: a folder that cannot be written
// stops a production boot with the folder named, and only warns outside production.
// The production boot is a real process started from src/server.ts with a folder under a plain
// file, so it can never be created.
// Does NOT cover container-start.sh or the Dockerfile, which need a Linux container and were
// checked with docker build and docker run; a real Railway volume; or two copies of the service
// writing one folder, which the host rules out by running one.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Hex } from "../src/types.js";

vi.hoisted(() => {
  process.env.PINATA_JWT = "test-token-not-a-real-pinata-jwt";
  process.env.PINATA_GATEWAY_URL = "https://moolam-test.mypinata.cloud/ipfs/";
});

const { PACKAGE_ROOT, parseEnv } = await import("../src/env.js");
const { env } = await import("../src/env.js");
const { PLATFORM_STATE_FILES, STATE_FILES, openStateFolders, probeFolder, stateFile } = await import("../src/stateDir.js");
const { DEFAULT_PLATFORM_LIMITS, platformStores } = await import("../src/platform/stores.js");
const { registryDomain } = await import("../src/platform/passport.js");
const { fileQueueStore, recheckQueue } = await import("../src/recheck/queue.js");
const { fileKeepTimes } = await import("../src/sealed.js");
const { fileCursorStore } = await import("../src/sweep.js");
const { DAY_ACTIONS, fileDayStore, globalDay } = await import("../src/limits/globalDay.js");
const { dailyQuota, fileQuotaStore } = await import("../src/generate/quota.js");
type DayAction = import("../src/limits/globalDay.js").DayAction;

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-30T13:00:00Z");
const PASSPORT = "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex;
const CEILINGS: Record<DayAction, number> = { prepares: 3, generations: 2, edits: 2, unseals: 1, links: 5 };

const root = mkdtempSync(path.join(tmpdir(), "moolam-state-"));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

let folders = 0;
function freshFolder(): string {
  folders += 1;
  const dir = path.join(root, `folder-${folders}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A folder that can never be created, because its parent is a plain file. */
function impossibleFolder(): string {
  const blocker = path.join(freshFolder(), "a-plain-file");
  writeFileSync(blocker, "not a folder\n");
  return path.join(blocker, "state");
}

describe("the data folder setting", () => {
  it("takes DATA_DIR first, then the Railway volume, then the local folder, and puts the queue in it", () => {
    const named = parseEnv({ DATA_DIR: "/data", RAILWAY_VOLUME_MOUNT_PATH: "/volume" });
    expect(named.DATA_DIR).toBe("/data");
    expect(named.DATA_DIR_SOURCE).toBe("DATA_DIR");
    expect(named.RECHECK_QUEUE_PATH).toBe(path.join("/data", "recheck-queue.json"));

    const volume = parseEnv({ RAILWAY_VOLUME_MOUNT_PATH: "/volume" });
    expect(volume.DATA_DIR).toBe("/volume");
    expect(volume.DATA_DIR_SOURCE).toBe("RAILWAY_VOLUME_MOUNT_PATH");

    const local = parseEnv({ DATA_DIR: "", RAILWAY_VOLUME_MOUNT_PATH: "" });
    expect(local.DATA_DIR).toBe(path.join(PACKAGE_ROOT, "test-assets", "state"));
    expect(local.DATA_DIR_SOURCE).toBe("default");
  });

  it("keeps RECHECK_QUEUE_PATH working when it is set", () => {
    const env = parseEnv({ DATA_DIR: "/data", RECHECK_QUEUE_PATH: "/elsewhere/queue.json" });
    expect(env.RECHECK_QUEUE_PATH).toBe("/elsewhere/queue.json");
    expect(env.DATA_DIR).toBe("/data");
  });

  it("refuses a folder that is relative or has spaces around it, since the start script would read it differently", () => {
    expect(() => parseEnv({ DATA_DIR: "data" })).toThrow(/DATA_DIR must be an absolute path/);
    expect(() => parseEnv({ DATA_DIR: " /data" })).toThrow(/DATA_DIR must be an absolute path/);
    expect(() => parseEnv({ RAILWAY_VOLUME_MOUNT_PATH: "/data " })).toThrow(/RAILWAY_VOLUME_MOUNT_PATH must be/);
  });
});

/**
 * One restart per state file: write through one instance, read through a fresh one on the same
 * file, the way a new container reads what the last one left on the volume. Keyed by STATE_FILES
 * so a new state file with no restart test here fails the check below.
 */
const restarts: Record<keyof typeof STATE_FILES | "queue", (dir: string) => void> = {
  queue: (dir) => {
    const file = path.join(dir, "recheck-queue.json");
    const before = recheckQueue({ store: fileQueueStore(file), now: () => NOW });
    before.request(PASSPORT);
    before.claim(PASSPORT);

    const after = recheckQueue({ store: fileQueueStore(file), now: () => NOW + 1000 });
    expect(after.status(PASSPORT)).toMatchObject({ status: "running", startedAt: NOW });
  },
  keepTimes: (dir) => {
    const file = path.join(dir, STATE_FILES.keepTimes);
    fileKeepTimes(file, () => NOW).note(PASSPORT, NOW - 5000);
    expect(fileKeepTimes(file, () => NOW).latest(PASSPORT)).toBe(NOW - 5000);
  },
  sweepCursor: (dir) => {
    const file = path.join(dir, STATE_FILES.sweepCursor);
    fileCursorStore(file).write("page-token-42");
    expect(fileCursorStore(file).read()).toBe("page-token-42");
  },
  dayCeilings: (dir) => {
    const file = path.join(dir, STATE_FILES.dayCeilings);
    const before = globalDay(CEILINGS, () => NOW, { store: fileDayStore(file) });
    before.tryTake("prepares");
    before.tryTake("prepares");
    before.tryTake("edits").giveBack();
    before.tryTake("unseals");

    const after = globalDay(CEILINGS, () => NOW + 60_000, { store: fileDayStore(file) });
    expect(after.counts()).toMatchObject({
      prepares: { used: 2, max: 3 },
      edits: { used: 0, max: 2 },
      unseals: { used: 1, max: 1 },
    });
    expect(after.tryTake("unseals").ok).toBe(false);
    expect(after.tryTake("prepares").ok).toBe(true);
    expect(after.tryTake("prepares").ok).toBe(false);
  },
  generateQuota: (dir) => quotaRestart(path.join(dir, STATE_FILES.generateQuota)),
  editQuota: (dir) => quotaRestart(path.join(dir, STATE_FILES.editQuota)),
  unsealQuota: (dir) => quotaRestart(path.join(dir, STATE_FILES.unsealQuota)),
};

function quotaRestart(file: string): void {
  const before = dailyQuota(2, { store: fileQuotaStore(file), now: () => NOW });
  expect(before.take("did:privy:alice").ok).toBe(true);
  const handedBack = dailyQuota(2, { store: fileQuotaStore(file), now: () => NOW + 1 }).take("did:privy:bob");
  expect(handedBack.ok).toBe(true);

  const middle = dailyQuota(2, { store: fileQuotaStore(file), now: () => NOW + 2 });
  middle.release("did:privy:bob", handedBack.ticket ?? 0);
  middle.take("did:privy:alice");

  const after = dailyQuota(2, { store: fileQuotaStore(file), now: () => NOW + 3 });
  expect(after.state("did:privy:alice").used).toBe(2);
  expect(after.take("did:privy:alice").ok).toBe(false);
  expect(after.state("did:privy:bob").used).toBe(0);

  const nextDay = dailyQuota(2, { store: fileQuotaStore(file), now: () => NOW + DAY + 3 });
  expect(nextDay.take("did:privy:alice").ok).toBe(true);
}

describe("every state file across a restart", () => {
  it("has a restart test for every file the data folder holds", () => {
    expect(Object.keys(restarts).sort()).toEqual([...Object.keys(STATE_FILES), "queue"].sort());
  });

  for (const [name, restart] of Object.entries(restarts)) {
    it(`keeps ${name} across a restart`, () => {
      restart(freshFolder());
    });
  }
});

describe("where each state file lives", () => {
  it("resolves every state file directly under the data folder, the platform's files and pending folder included", () => {
    const dir = freshFolder();
    const saved = { NODE_ENV: env.NODE_ENV, DATA_DIR: env.DATA_DIR };
    // Under a test runner stateFile holds everything in memory, so the host's own settings are put
    // in place for this one check and restored after it.
    env.NODE_ENV = "development";
    env.DATA_DIR = dir;
    try {
      for (const name of [...Object.values(STATE_FILES), ...Object.values(PLATFORM_STATE_FILES)]) {
        expect(stateFile(name), name).toBe(path.join(dir, name));
      }

      const stores = platformStores(undefined, DEFAULT_PLATFORM_LIMITS, registryDomain(), () => undefined);
      expect(stores.pending).toBeDefined();
      const platform = `0x${"ab".repeat(32)}` as Hex;
      expect(stores.quota.take(platform).ok).toBe(true);
      expect(stores.day.tryTake("prepares").ok).toBe(true);
      const accepted = stores.nonces.accept(
        { platform, nonce: `0x${"cd".repeat(32)}` as Hex, picture: PASSPORT, expiresAt: Math.floor(NOW / 1000) + 600 },
        BigInt(Math.floor(NOW / 1000)),
      );
      expect(accepted.ok).toBe(true);
      expect(readdirSync(dir).sort()).toEqual(Object.values(PLATFORM_STATE_FILES).sort());
    } finally {
      env.NODE_ENV = saved.NODE_ENV;
      env.DATA_DIR = saved.DATA_DIR;
    }
  });
});

describe("a ceiling file that cannot be believed", () => {
  const tampered: Record<string, (file: string) => void> = {
    "is not JSON": (file) => writeFileSync(file, "{ prepares: 0"),
    "has a negative count": (file) =>
      writeFileSync(file, JSON.stringify({ version: 1, day: Math.floor(NOW / DAY), used: { prepares: -5, generations: 0, edits: 0, unseals: 0, links: 0 } })),
    "is missing an action": (file) =>
      writeFileSync(file, JSON.stringify({ version: 1, day: Math.floor(NOW / DAY), used: { prepares: 0, generations: 0, edits: 0, unseals: 0 } })),
    "is from another version": (file) =>
      writeFileSync(file, JSON.stringify({ version: 2, day: Math.floor(NOW / DAY), used: { prepares: 0, generations: 0, edits: 0, unseals: 0, links: 0 } })),
    "is stamped far in the future": (file) =>
      writeFileSync(file, JSON.stringify({ version: 1, day: Math.floor(NOW / DAY) + 30, used: { prepares: 0, generations: 0, edits: 0, unseals: 0, links: 0 } })),
    "cannot be read at all": (file) => mkdirSync(file),
  };

  for (const [how, tamper] of Object.entries(tampered)) {
    it(`reads as the ceiling already reached when the file ${how}`, () => {
      const file = path.join(freshFolder(), STATE_FILES.dayCeilings);
      tamper(file);
      const lines: string[] = [];

      const day = globalDay(CEILINGS, () => NOW, { store: fileDayStore(file), log: (line) => lines.push(line) });

      for (const action of DAY_ACTIONS) {
        expect(day.tryTake(action).ok).toBe(false);
        expect(day.counts()[action]).toEqual({ used: CEILINGS[action], max: CEILINGS[action] });
      }
      expect(lines.some((line) => line.includes("read as already reached until midnight UTC"))).toBe(true);
    });
  }

  it("stays closed through a second restart the same day and opens the next day", () => {
    const file = path.join(freshFolder(), STATE_FILES.dayCeilings);
    writeFileSync(file, "tampered");
    globalDay(CEILINGS, () => NOW, { store: fileDayStore(file) });

    const sameDay = globalDay(CEILINGS, () => NOW + 60_000, { store: fileDayStore(file) });
    expect(sameDay.tryTake("prepares").ok).toBe(false);

    const nextDay = globalDay(CEILINGS, () => NOW + DAY, { store: fileDayStore(file) });
    expect(nextDay.tryTake("prepares").ok).toBe(true);
    expect(nextDay.counts().prepares.used).toBe(1);
  });
});

describe("a quota file that cannot be believed", () => {
  it("reads every creator as having spent the allowance, through a restart, until the window has passed", () => {
    const file = path.join(freshFolder(), STATE_FILES.generateQuota);
    writeFileSync(file, JSON.stringify({ version: 1, spends: { "did:privy:alice": [-1] } }));
    const lines: string[] = [];

    const quota = dailyQuota(3, { store: fileQuotaStore(file), now: () => NOW, log: (line) => lines.push(line) });
    expect(quota.take("did:privy:someone-new").ok).toBe(false);
    expect(quota.state("did:privy:someone-new")).toEqual({ used: 3, limit: 3, resetsAt: Math.floor((NOW + DAY) / 1000) });
    expect(lines.some((line) => line.includes("every creator reads as having spent this allowance"))).toBe(true);

    const restarted = dailyQuota(3, { store: fileQuotaStore(file), now: () => NOW + 60_000 });
    expect(restarted.take("did:privy:someone-new").ok).toBe(false);

    const later = dailyQuota(3, { store: fileQuotaStore(file), now: () => NOW + DAY + 1 });
    expect(later.take("did:privy:someone-new").ok).toBe(true);
  });

  it("refuses a stamp from further ahead than one window", () => {
    const file = path.join(freshFolder(), STATE_FILES.editQuota);
    writeFileSync(file, JSON.stringify({ version: 1, spends: { "did:privy:alice": [NOW + 400 * DAY] } }));

    const quota = dailyQuota(3, { store: fileQuotaStore(file), now: () => NOW });
    expect(quota.take("did:privy:bob").ok).toBe(false);
  });
});

describe("the boot check on the data folder", () => {
  it("proves a folder by writing and renaming a file in it, and leaves nothing behind", () => {
    const dir = path.join(freshFolder(), "made-by-the-probe");
    expect(probeFolder(dir)).toEqual({ dir, writable: true });
    expect(probeFolder(impossibleFolder()).writable).toBe(false);
  });

  it("stops a production boot and names the folder when it cannot be written", () => {
    const dir = impossibleFolder();
    expect(() =>
      openStateFolders(
        { dataDir: dir, queuePath: path.join(dir, "recheck-queue.json"), source: "DATA_DIR", production: true },
        () => undefined,
      ),
    ).toThrow(`the data folder ${dir} cannot be written`);
  });

  it("warns and holds state in memory outside production", () => {
    const dir = impossibleFolder();
    const lines: string[] = [];
    const result = openStateFolders(
      { dataDir: dir, queuePath: path.join(dir, "recheck-queue.json"), source: "DATA_DIR", production: false },
      (line) => lines.push(line),
    );
    expect(result).toEqual({ data: false, queue: false });
    expect(lines).toEqual([expect.stringContaining(`the data folder ${dir} cannot be written`)]);
    expect(lines[0]).toContain("held in memory only");
  });

  it("says once when a production host keeps its state on the image's own disk", () => {
    const dir = freshFolder();
    const lines: string[] = [];
    openStateFolders(
      { dataDir: dir, queuePath: path.join(dir, "recheck-queue.json"), source: "default", production: true },
      (line) => lines.push(line),
    );
    expect(lines).toEqual([expect.stringContaining("every deploy starts it empty")]);
  });

  it("stops the real service at boot in production, with one line naming the folder", () => {
    const dir = impossibleFolder();
    const run = spawnSync(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
      timeout: 90_000,
      env: {
        ...process.env,
        NODE_ENV: "production",
        PASSPORT_SOURCE: "envio",
        ENVIO_GRAPHQL_URL: "http://127.0.0.1:9/v1/graphql",
        DATA_DIR: dir,
        RECHECK_QUEUE_PATH: "",
        PRIVY_JWKS_OVERRIDE_PATH: "",
        X402_ENABLED: "false",
        EXPECT_ROUTES: "",
        VERIFIER_PORT: "45999",
      },
    });

    expect(run.status).toBe(1);
    expect(run.stderr.trim().split("\n")).toEqual([expect.stringContaining(`the data folder ${dir} cannot be written`)]);
    expect(() => readFileSync(path.join(dir, "recheck-queue.json"))).toThrow();
  }, 120_000);
});
