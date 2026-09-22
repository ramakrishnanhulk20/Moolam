// Covers the re-check queue as a module: what a request does, what a second one for the same
// passport does, how a runner claims and finishes work, when an abandoned claim may be taken
// again, and the two ceilings that keep the file small (a finished request is dropped after seven
// days, and the queue never holds more than its cap). It also covers the file behind it: a round
// trip through disk, a missing file, a file that is not JSON, a file from another version, and the
// crash this store exists to survive, where the process dies between the temp file and the rename.
// Time is injected everywhere, so nothing here waits and nothing depends on the machine's clock.
// Does NOT cover the HTTP routes, which are in test/recheck-routes.test.ts, and does not cover the
// runner, which lives in its own package.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  KEEP_FINISHED_MS,
  fileQueueStore,
  memoryQueueStore,
  recheckQueue,
  type QueueStore,
  type RecheckItem,
} from "../src/recheck/queue.js";
import type { Hex } from "../src/types.js";

const ONE = "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex;
const TWO = "0x2222222222222222222222222222222222222222222222222222222222222222" as Hex;
const THREE = "0x3333333333333333333333333333333333333333333333333333333333333333" as Hex;
const TX = "0xabababababababababababababababababababababababababababababababab";

const START = 1_790_000_000_000;

/** A clock the test moves by hand, so a thirty minute claim and a seven day drop cost no waiting. */
function clock(at = START): { now: () => number; move: (ms: number) => void } {
  let current = at;
  return {
    now: () => current,
    move: (ms) => {
      current += ms;
    },
  };
}

function idFrom(index: number): Hex {
  return `0x${index.toString(16).padStart(64, "0")}` as Hex;
}

const folders: string[] = [];

function tempFile(name: string): string {
  const folder = mkdtempSync(path.join(tmpdir(), "moolam-recheck-"));
  folders.push(folder);
  return path.join(folder, name);
}

afterAll(() => {
  for (const folder of folders) {
    rmSync(folder, { recursive: true, force: true });
  }
});

describe("the re-check queue", () => {
  let time: ReturnType<typeof clock>;
  let store: QueueStore;

  beforeEach(() => {
    time = clock();
    store = memoryQueueStore();
  });

  it("records a request as pending, with the time and the place in the queue", () => {
    const queue = recheckQueue({ store, now: time.now });

    const first = queue.request(ONE);
    const second = queue.request(TWO);

    expect(first).toMatchObject({ ok: true, already: false, position: 1 });
    expect(second).toMatchObject({ ok: true, already: false, position: 2 });
    expect(queue.status(ONE)).toEqual({
      passportId: ONE,
      status: "pending",
      requestedAt: START,
      requestedBy: "public",
    });
    expect(queue.counts()).toEqual({ pending: 2, running: 0 });
  });

  it("answers a second request for a waiting passport with the same record", () => {
    const queue = recheckQueue({ store, now: time.now });
    queue.request(ONE);
    time.move(5_000);

    const again = queue.request(ONE);

    expect(again).toMatchObject({ ok: true, already: true, position: 1 });
    expect(again.ok && again.item.requestedAt).toBe(START);
    expect(queue.all()).toHaveLength(1);
  });

  it("answers a second request for a passport already running, without disturbing the run", () => {
    const queue = recheckQueue({ store, now: time.now });
    queue.request(ONE);
    queue.claim(ONE);

    const again = queue.request(ONE);

    expect(again).toMatchObject({ ok: true, already: true, position: 0 });
    expect(again.ok && again.item.status).toBe("running");
  });

  it("starts a fresh request at the back of the queue once the last one finished", () => {
    const queue = recheckQueue({ store, now: time.now });
    queue.request(ONE);
    queue.claim(ONE);
    queue.finish(ONE, { reportTx: TX });
    queue.request(TWO);
    time.move(1_000);

    const again = queue.request(ONE);

    expect(again).toMatchObject({ ok: true, already: false, position: 2 });
    expect(again.ok && again.item.requestedAt).toBe(START + 1_000);
    expect(queue.pending(10).map((item) => item.passportId)).toEqual([TWO, ONE]);
  });

  it("hands the runner the oldest waiting requests first, at most the page asked for", () => {
    const queue = recheckQueue({ store, now: time.now });
    queue.request(ONE);
    queue.request(TWO);
    queue.request(THREE);
    queue.claim(TWO);

    expect(queue.pending(2).map((item) => item.passportId)).toEqual([ONE, THREE]);
    expect(queue.counts()).toEqual({ pending: 2, running: 1 });
  });

  it("claims a waiting request and refuses one another runner is already on", () => {
    const queue = recheckQueue({ store, now: time.now });
    queue.request(ONE);

    const claimed = queue.claim(ONE);
    const second = queue.claim(ONE);

    expect(claimed).toMatchObject({ ok: true, reclaimed: false });
    expect(claimed.ok && claimed.item).toMatchObject({ status: "running", startedAt: START });
    expect(second).toEqual({ ok: false, refused: "already-running" });
  });

  it("lets a request be claimed again once the runner has been gone half an hour", () => {
    const queue = recheckQueue({ store, now: time.now });
    queue.request(ONE);
    queue.claim(ONE);

    time.move(29 * 60 * 1000);
    expect(queue.claim(ONE)).toEqual({ ok: false, refused: "already-running" });

    time.move(2 * 60 * 1000);
    const again = queue.claim(ONE);
    expect(again).toMatchObject({ ok: true, reclaimed: true });
    expect(again.ok && again.item.startedAt).toBe(START + 31 * 60 * 1000);
  });

  it("refuses to claim a passport nobody asked about, or one that is already answered", () => {
    const queue = recheckQueue({ store, now: time.now });
    queue.request(ONE);
    queue.claim(ONE);
    queue.finish(ONE, { reportTx: TX });

    expect(queue.claim(TWO)).toEqual({ ok: false, refused: "no-request" });
    expect(queue.claim(ONE)).toEqual({ ok: false, refused: "not-pending" });
  });

  it("closes a run as done when there is a report transaction and keeps the verdict", () => {
    const queue = recheckQueue({ store, now: time.now });
    queue.request(ONE);
    queue.claim(ONE);
    time.move(90_000);

    const finished = queue.finish(ONE, { reportTx: TX, matched: true, distance: 2 });

    expect(finished.ok && finished.item).toEqual({
      passportId: ONE,
      status: "done",
      requestedAt: START,
      requestedBy: "public",
      startedAt: START,
      finishedAt: START + 90_000,
      reportTx: TX,
      matched: true,
      distance: 2,
      reason: undefined,
    });
  });

  it("closes a run as failed with no transaction, and cuts the reason to 200 characters", () => {
    const queue = recheckQueue({ store, now: time.now });
    queue.request(ONE);
    queue.claim(ONE);

    const finished = queue.finish(ONE, { reason: "x".repeat(500) });

    expect(finished.ok && finished.item.status).toBe("failed");
    expect(finished.ok && finished.item.reason).toHaveLength(200);
    expect(finished.ok && finished.item.reportTx).toBeUndefined();
  });

  it("refuses a report for a request nobody claimed", () => {
    const queue = recheckQueue({ store, now: time.now });
    queue.request(ONE);

    expect(queue.finish(TWO, { reportTx: TX })).toEqual({ ok: false, refused: "no-request" });
    expect(queue.finish(ONE, { reportTx: TX })).toEqual({ ok: false, refused: "not-running" });
  });

  it("drops a finished request after seven days, and keeps one a day younger", () => {
    const queue = recheckQueue({ store, now: time.now });
    queue.request(ONE);
    queue.claim(ONE);
    queue.finish(ONE, { reportTx: TX });
    time.move(6 * 24 * 60 * 60 * 1000);
    queue.request(TWO);
    queue.claim(TWO);
    queue.finish(TWO, { reason: "the simulator timed out" });

    time.move(KEEP_FINISHED_MS - 6 * 24 * 60 * 60 * 1000 + 1);

    expect(queue.status(ONE)).toBeUndefined();
    expect(queue.status(TWO)?.status).toBe("failed");
  });

  it("never holds more than the cap, dropping the oldest answered request to make room", () => {
    const queue = recheckQueue({ store, now: time.now, maxItems: 3 });
    for (const id of [ONE, TWO, THREE]) {
      queue.request(id);
      queue.claim(id);
      queue.finish(id, { reportTx: TX });
      time.move(1_000);
    }

    queue.request(idFrom(9));

    expect(queue.all()).toHaveLength(3);
    expect(queue.status(ONE)).toBeUndefined();
    expect(queue.status(TWO)?.status).toBe("done");
    expect(queue.status(idFrom(9))?.status).toBe("pending");
  });

  it("refuses a new request rather than dropping one that is still waiting", () => {
    const queue = recheckQueue({ store, now: time.now, maxItems: 2 });
    queue.request(ONE);
    queue.request(TWO);

    expect(queue.request(THREE)).toEqual({ ok: false, refused: "queue-full" });
    expect(queue.status(ONE)?.status).toBe("pending");
    expect(queue.status(TWO)?.status).toBe("pending");
  });

  it("keeps taking requests when the file cannot be written, and says so once", () => {
    const lines: string[] = [];
    const broken: QueueStore = {
      read: () => ({ items: [] }),
      write: () => {
        throw new Error("EROFS: read-only file system");
      },
    };
    const queue = recheckQueue({ store: broken, now: time.now, log: (line) => lines.push(line) });

    queue.request(ONE);
    queue.request(TWO);

    expect(queue.counts()).toEqual({ pending: 2, running: 0 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("holding it in memory only");
  });

  it("starts from the requests the store already holds, in the order they were written", () => {
    const held: RecheckItem[] = [
      { passportId: ONE, status: "pending", requestedAt: START, requestedBy: "public" },
      { passportId: TWO, status: "running", requestedAt: START, requestedBy: "public", startedAt: START },
    ];
    const queue = recheckQueue({ store: memoryQueueStore(held), now: time.now });

    expect(queue.counts()).toEqual({ pending: 1, running: 1 });
    expect(queue.pending(10).map((item) => item.passportId)).toEqual([ONE]);
  });
});

describe("the queue file", () => {
  it("survives a round trip through disk", () => {
    const file = tempFile("queue.json");
    const store = fileQueueStore(file);
    const first = recheckQueue({ store, now: clock().now });
    first.request(ONE);
    first.claim(ONE);
    first.request(TWO);

    const second = recheckQueue({ store: fileQueueStore(file), now: clock().now });

    expect(second.counts()).toEqual({ pending: 1, running: 1 });
    expect(second.status(ONE)).toMatchObject({ status: "running", startedAt: START });
  });

  it("starts empty with a line to log when there is no file yet", () => {
    const lines: string[] = [];
    const file = tempFile("missing.json");

    const queue = recheckQueue({ store: fileQueueStore(file), log: (line) => lines.push(line) });

    expect(queue.all()).toEqual([]);
    expect(lines[0]).toContain("starting empty");
  });

  it("starts empty with a line to log when the file is not JSON, or is from another version", () => {
    const notJson = tempFile("broken.json");
    writeFileSync(notJson, "{ half a fil", "utf8");
    const older = tempFile("older.json");
    writeFileSync(older, JSON.stringify({ version: 99, items: [] }), "utf8");

    const first: string[] = [];
    const second: string[] = [];
    recheckQueue({ store: fileQueueStore(notJson), log: (line) => first.push(line) });
    recheckQueue({ store: fileQueueStore(older), log: (line) => second.push(line) });

    expect(first[0]).toContain("is not JSON");
    expect(second[0]).toContain("not a queue this version reads");
  });

  it("leaves the last good file untouched when the process dies between the temp file and the rename", () => {
    const file = tempFile("queue.json");
    const good = fileQueueStore(file);
    const queue = recheckQueue({ store: good, now: clock().now });
    queue.request(ONE);
    const before = readFileSync(file, "utf8");

    let crashed = false;
    const dying = fileQueueStore(file, {
      rename: () => {
        crashed = true;
        throw new Error("the process died here");
      },
    });
    const second = recheckQueue({ store: dying, now: clock().now, log: () => {} });
    second.request(TWO);

    expect(crashed).toBe(true);
    expect(existsSync(`${file}.tmp`)).toBe(true);
    expect(JSON.parse(readFileSync(`${file}.tmp`, "utf8")).items).toHaveLength(2);
    expect(readFileSync(file, "utf8")).toBe(before);

    const afterRestart = recheckQueue({ store: fileQueueStore(file) });
    expect(afterRestart.all().map((item) => item.passportId)).toEqual([ONE]);
  });
});
