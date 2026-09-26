// Covers the hourly sweep of private copies whose passport never reached the chain, against B9,
// B15 and D5 in docs/security/threat-model.md: off does nothing, dry only
// logs, delete deletes; only exact thumbnail names older than 48 hours by Pinata's created_at are
// considered, and a file is marked only when the chain answered that its passport does not exist;
// an RPC error, a listing that could not finish, and an answer in an unknown shape mark nothing;
// two runs never overlap, and nothing runs at boot. The Pinata listing is the real client against
// a stub at the fetch layer, so its paging and its bounds run for real.
// From the verifier review: the listing asks Pinata for no name filter at all, so whatever that
// filter matches cannot hide a file, and the exact name check here is the only one (V8); each run
// reads two pages from where the last one stopped, so every row is read in turn (V16), and the
// place it stopped is kept in a file, so a restart goes on from there rather than the first page.
// Does NOT cover a real Pinata account or a real chain read (the registry read is a stub here and
// its strict shape check is exercised only through a fake answer), whether a real page token
// outlives a day, or the server wiring, which test/health.test.ts reads through /health.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";

vi.hoisted(() => {
  process.env.PINATA_JWT = "test-token-not-a-real-pinata-jwt";
  process.env.PINATA_GATEWAY_URL = "https://moolam-test.mypinata.cloud/ipfs/";
});

const { privateSweep, fileCursorStore, SWEEP_FIRST_RUN_MS, SWEEP_EVERY_MS } = await import("../src/sweep.js");
const { listPrivatePage, PRIVATE_SWEEP_PAGES } = await import("../src/ipfs/pinata.js");
type SweepDeps = import("../src/sweep.js").SweepDeps;
type SweepLog = import("../src/sweep.js").SweepLog;

const PRIVATE_FILES_URL = "https://api.pinata.cloud/v3/files/private";
const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-09-23T12:00:00Z");

function idOf(byte: number): Hex {
  return `0x${byte.toString(16).padStart(2, "0").repeat(32)}` as Hex;
}

function nameOf(id: Hex): string {
  return `sealed-thumb-${id}.jpg`;
}

function hoursAgo(hours: number): string {
  return new Date(NOW - hours * HOUR).toISOString();
}

interface Row {
  id: string;
  name: string | null;
  cid: string;
  created_at?: string;
}

/** The stub account, listed in pages. Rows whose page offset is in `failAt` answer 500 instead. */
const account: Row[] = [];
const failAt = new Set<number>();
const listed: string[] = [];
let counter = 0;

function row(name: string | null, createdAt: string | undefined): Row {
  counter += 1;
  const file: Row = {
    id: `0199a3c2-5d7e-7f10-9a1b-${counter.toString(16).padStart(12, "0")}`,
    name,
    cid: `bafkreiprivate${counter.toString().padStart(30, "0")}`,
  };
  if (createdAt !== undefined) file.created_at = createdAt;
  account.push(file);
  return file;
}

/**
 * Pinata's listing at the fetch layer. The name filter matches anywhere in the name, the loosest
 * reading of an undocumented rule, so the checks in our code are what the tests see, unless a test
 * switches it to whole names only, the strictest reading. Anything else that tries to leave the
 * process fails the test.
 */
let wholeNamesOnly = false;
function stubPinata(): void {
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(`${PRIVATE_FILES_URL}?`) && (init?.method ?? "GET") === "GET") {
      listed.push(url);
      const query = new URL(url).searchParams;
      const filter = query.get("name") ?? "";
      const limit = Number(query.get("limit"));
      const offset = Number(query.get("pageToken") ?? "0");
      if (failAt.has(offset)) {
        return new Response("down", { status: 500 });
      }
      const matching = account.filter((file) =>
        wholeNamesOnly && query.has("name") ? file.name === filter : (file.name ?? "").includes(filter),
      );
      const page = matching.slice(offset, offset + limit);
      const next = offset + limit < matching.length ? String(offset + limit) : "";
      return new Response(JSON.stringify({ data: { files: page, next_page_token: next } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error("this test makes no live call");
  });
}

/** The chain: true for a registered passport, false for one it says does not exist, throws for the rest. */
const chain = new Map<Hex, boolean>();
const removed: string[] = [];

function recordingLog(): SweepLog & { lines: { level: string; fields: Record<string, unknown>; message: string }[] } {
  const lines: { level: string; fields: Record<string, unknown>; message: string }[] = [];
  const at = (level: string) => (fields: unknown, message?: unknown): void => {
    lines.push({ level, fields: fields as Record<string, unknown>, message: String(message) });
  };
  return { lines, info: at("info"), warn: at("warn"), error: at("error") } as unknown as SweepLog & {
    lines: typeof lines;
  };
}

function deps(overrides: Partial<SweepDeps> = {}): Partial<SweepDeps> {
  return {
    registered: async (id) => {
      const held = chain.get(id);
      if (held === undefined) throw new Error("the RPC timed out");
      return held;
    },
    remove: async (fileId) => {
      removed.push(fileId);
    },
    now: () => NOW,
    ...overrides,
  };
}

beforeEach(() => {
  wholeNamesOnly = false;
  account.length = 0;
  failAt.clear();
  listed.length = 0;
  chain.clear();
  removed.length = 0;
  stubPinata();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the private copy sweep (B9, D5)", () => {
  it("off lists nothing, dry logs what it would delete and deletes nothing, delete deletes it", async () => {
    const orphan = idOf(0x01);
    chain.set(orphan, false);
    const file = row(nameOf(orphan), hoursAgo(72));

    const offLog = recordingLog();
    const off = privateSweep({ mode: "off", log: offLog, deps: deps() });
    expect(await off.runOnce()).toBeUndefined();
    expect(listed).toHaveLength(0);
    expect(off.state()).toEqual({ mode: "off", lastRun: null });

    const dryLog = recordingLog();
    const dry = privateSweep({ mode: "dry", log: dryLog, deps: deps() });
    const dryRun = await dry.runOnce();
    expect(dryRun?.outcome).toBe("finished");
    expect(dryRun?.counts).toMatchObject({ listed: 1, marked: 1, deleted: 0, failed: 0 });
    expect(removed).toHaveLength(0);
    const would = dryLog.lines.find((line) => line.message.includes("would delete"));
    expect(would?.fields).toEqual({ name: file.name, ageHours: 72 });
    expect(JSON.stringify(dryLog.lines)).not.toContain("https://");
    expect(JSON.stringify(dryLog.lines)).not.toContain(file.id);
    expect(dry.state().lastRun?.counts.marked).toBe(1);

    const deleteLog = recordingLog();
    const deleting = privateSweep({ mode: "delete", log: deleteLog, deps: deps() });
    const deleteRun = await deleting.runOnce();
    expect(deleteRun?.outcome).toBe("finished");
    expect(deleteRun?.counts).toMatchObject({ marked: 1, deleted: 1, failed: 0 });
    expect(removed).toEqual([file.id]);
    const finished = deleteLog.lines.find((line) => line.message === "sweep: run finished");
    expect(finished?.fields).toMatchObject({ mode: "delete", marked: 1, deleted: 1 });
  });

  it("D5: keeps a 47 hour old file and marks a 49 hour old one, by Pinata's created_at", async () => {
    const young = idOf(0x02);
    const old = idOf(0x03);
    chain.set(young, false);
    chain.set(old, false);
    row(nameOf(young), hoursAgo(47));
    const oldFile = row(nameOf(old), hoursAgo(49));

    const run = await privateSweep({ mode: "delete", log: recordingLog(), deps: deps() }).runOnce();

    expect(run?.counts).toMatchObject({ listed: 2, young: 1, marked: 1, deleted: 1 });
    expect(removed).toEqual([oldFile.id]);
  });

  it("B9: marks nothing when a chain read fails, even for files the chain already answered for", async () => {
    const answered = idOf(0x04);
    const unanswered = idOf(0x05);
    chain.set(answered, false);
    row(nameOf(answered), hoursAgo(60));
    row(nameOf(unanswered), hoursAgo(60));
    const log = recordingLog();

    const run = await privateSweep({ mode: "delete", log, deps: deps() }).runOnce();

    expect(run?.outcome).toBe("stopped");
    expect(run?.counts.marked).toBe(0);
    expect(removed).toHaveLength(0);
    expect(log.lines.some((line) => line.message.includes("the chain did not answer"))).toBe(true);
  });

  it("B9: marks nothing when a page of the listing could not be read, and nothing when the chain answers in an unknown shape", async () => {
    const orphan = idOf(0x06);
    chain.set(orphan, false);
    row(nameOf(orphan), hoursAgo(60));
    for (let i = 0; i < 120; i += 1) {
      row(nameOf(idOf(0x07)).replace(".jpg", `-${i}.jpg`), hoursAgo(60));
    }
    failAt.add(100);

    const halfRead = await privateSweep({ mode: "delete", log: recordingLog(), deps: deps() }).runOnce();

    expect(listed).toHaveLength(2);
    expect(halfRead?.outcome).toBe("stopped");
    expect(halfRead?.counts.marked).toBe(0);
    expect(removed).toHaveLength(0);

    failAt.clear();
    const oddAnswer = await privateSweep({
      mode: "delete",
      log: recordingLog(),
      deps: deps({ registered: async () => undefined as unknown as boolean }),
    }).runOnce();
    expect(oddAnswer?.counts.marked).toBe(0);
    expect(removed).toHaveLength(0);
  });

  it("B9: skips and counts any name that is not exactly a thumbnail name, sealed-thumb-0xabc.jpg.exe included", async () => {
    const orphan = idOf(0xab);
    chain.set(orphan, false);
    row("sealed-thumb-0xabc.jpg.exe", hoursAgo(60));
    row(`${nameOf(orphan)}.exe`, hoursAgo(60));
    row(nameOf(orphan).toUpperCase().replace("SEALED-THUMB-0X", "sealed-thumb-0x"), hoursAgo(60));
    row(`x-${nameOf(orphan)}`, hoursAgo(60));
    row(null, hoursAgo(60));

    const run = await privateSweep({ mode: "delete", log: recordingLog(), deps: deps() }).runOnce();

    expect(run?.outcome).toBe("finished");
    expect(run?.counts).toMatchObject({ listed: 4, oddNames: 4, marked: 0 });
    expect(removed).toHaveLength(0);
  });

  it("B9: keeps the file of a passport the chain holds, and skips one whose upload time is not a date", async () => {
    const registered = idOf(0x09);
    const undated = idOf(0x0a);
    chain.set(registered, true);
    chain.set(undated, false);
    row(nameOf(registered), hoursAgo(500));
    row(nameOf(undated), "yesterday");
    row(nameOf(undated), undefined);
    row(nameOf(undated), "1");

    const run = await privateSweep({ mode: "delete", log: recordingLog(), deps: deps() }).runOnce();

    expect(run?.counts).toMatchObject({ listed: 4, registered: 1, undated: 3, marked: 0 });
    expect(removed).toHaveLength(0);
  });

  it("deletes every file under an orphan's name, and counts a delete Pinata refused without stopping", async () => {
    const orphan = idOf(0x0b);
    chain.set(orphan, false);
    const first = row(nameOf(orphan), hoursAgo(60));
    const second = row(nameOf(orphan), hoursAgo(59));

    const run = await privateSweep({
      mode: "delete",
      log: recordingLog(),
      deps: deps({
        remove: async (fileId) => {
          if (fileId === first.id) throw new Error("Pinata answered 500");
          removed.push(fileId);
        },
      }),
    }).runOnce();

    expect(run?.counts).toMatchObject({ marked: 2, deleted: 1, failed: 1 });
    expect(removed).toEqual([second.id]);
  });

  it("never runs two at once: a run asked for while one is going is skipped and lists nothing", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let lists = 0;
    const log = recordingLog();
    const sweep = privateSweep({
      mode: "dry",
      log,
      deps: deps({
        list: async () => {
          lists += 1;
          await gate;
          return { files: [], next: undefined };
        },
      }),
    });

    const first = sweep.runOnce();
    const second = await sweep.runOnce();
    release();
    const finished = await first;

    expect(second).toBeUndefined();
    expect(finished?.outcome).toBe("finished");
    expect(lists).toBe(1);
    expect(log.lines.some((line) => line.message.includes("still going"))).toBe(true);
    expect((await sweep.runOnce())?.outcome).toBe("finished");
    expect(lists).toBe(2);
  });

  it("D5: does not run at boot, runs first an hour later and then every hour, and off never schedules", async () => {
    vi.useFakeTimers();
    let lists = 0;
    const list = async (): Promise<{ files: never[]; next: undefined }> => {
      lists += 1;
      return { files: [], next: undefined };
    };
    const sweep = privateSweep({ mode: "dry", log: recordingLog(), deps: deps({ list }) });
    const off = privateSweep({ mode: "off", log: recordingLog(), deps: deps({ list }) });

    const stop = sweep.start();
    const stopOff = off.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(lists).toBe(0);
    await vi.advanceTimersByTimeAsync(SWEEP_FIRST_RUN_MS - 1);
    expect(lists).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(lists).toBe(1);
    await vi.advanceTimersByTimeAsync(SWEEP_EVERY_MS);
    expect(lists).toBe(2);

    stop();
    stopOff();
    await vi.advanceTimersByTimeAsync(3 * SWEEP_EVERY_MS);
    expect(lists).toBe(2);
  });
});

describe("V8: names matched exactly, whatever Pinata's name filter does", () => {
  it("finds an orphan when Pinata's name filter matches only whole names, because it asks with none", async () => {
    wholeNamesOnly = true;
    const orphan = idOf(0x31);
    chain.set(orphan, false);
    const file = row(nameOf(orphan), hoursAgo(60));

    const run = await privateSweep({ mode: "delete", log: recordingLog(), deps: deps() }).runOnce();

    expect(run?.counts).toMatchObject({ listed: 1, marked: 1, deleted: 1 });
    expect(removed).toEqual([file.id]);
    expect(listed.every((url) => !new URL(url).searchParams.has("name"))).toBe(true);
  });
});

describe("V16: every row is read in turn across runs", () => {
  it("reads two pages a run from where the last run stopped, and reaches an orphan past row 200", async () => {
    for (let i = 0; i < 250; i += 1) {
      const id = `0x${i.toString(16).padStart(4, "0").repeat(16)}` as Hex;
      chain.set(id, true);
      row(nameOf(id), hoursAgo(60));
    }
    const orphan = idOf(0x32);
    chain.set(orphan, false);
    const late = row(nameOf(orphan), hoursAgo(60));
    const sweep = privateSweep({ mode: "delete", log: recordingLog(), deps: deps() });

    const first = await sweep.runOnce();
    expect(first?.counts).toMatchObject({ listed: 200, registered: 200, marked: 0 });
    expect(first?.more).toBe(true);
    expect(removed).toHaveLength(0);

    const second = await sweep.runOnce();
    expect(second?.counts).toMatchObject({ listed: 51, registered: 50, marked: 1, deleted: 1 });
    expect(second?.more).toBe(false);
    expect(removed).toEqual([late.id]);
    expect(new URL(listed[2] as string).searchParams.get("pageToken")).toBe("200");

    // The listing ended, so the next run starts at the first page again.
    await sweep.runOnce();
    expect(new URL(listed[3] as string).searchParams.get("pageToken")).toBeNull();
  });

  it("starts again from the first page when a saved page cannot be read", async () => {
    for (let i = 0; i < 250; i += 1) {
      const id = `0x${i.toString(16).padStart(4, "0").repeat(16)}` as Hex;
      chain.set(id, true);
      row(nameOf(id), hoursAgo(60));
    }
    const sweep = privateSweep({ mode: "dry", log: recordingLog(), deps: deps() });
    await sweep.runOnce();
    failAt.add(200);

    expect((await sweep.runOnce())?.outcome).toBe("stopped");
    failAt.clear();
    const mark = listed.length;
    await sweep.runOnce();
    expect(new URL(listed[mark] as string).searchParams.get("pageToken")).toBeNull();
  });
});

describe("the sweep's place survives a restart", () => {
  it("goes on from the saved page after a restart, and from the first page when the file is not one it wrote", async () => {
    const folder = mkdtempSync(path.join(tmpdir(), "moolam-sweep-"));
    try {
      for (let i = 0; i < 250; i += 1) {
        const id = `0x${i.toString(16).padStart(4, "0").repeat(16)}` as Hex;
        chain.set(id, true);
        row(nameOf(id), hoursAgo(60));
      }
      const file = path.join(folder, "private-sweep-cursor.json");

      const before = privateSweep({ mode: "dry", log: recordingLog(), deps: deps({ cursor: fileCursorStore(file) }) });
      expect((await before.runOnce())?.more).toBe(true);

      // A redeploy: a new sweep over the same file.
      const after = privateSweep({ mode: "dry", log: recordingLog(), deps: deps({ cursor: fileCursorStore(file) }) });
      const mark = listed.length;
      expect((await after.runOnce())?.counts).toMatchObject({ listed: 50 });
      expect(new URL(listed[mark] as string).searchParams.get("pageToken")).toBe("200");

      // The listing ended, so the saved place is the first page again, for this run and a restart.
      const again = privateSweep({ mode: "dry", log: recordingLog(), deps: deps({ cursor: fileCursorStore(file) }) });
      await again.runOnce();
      expect(new URL(listed[mark + 1] as string).searchParams.get("pageToken")).toBeNull();

      for (const junk of ["not json", JSON.stringify({ version: 1, next: "has spaces in it" }), JSON.stringify({ next: "200" })]) {
        writeFileSync(file, junk, "utf8");
        const fresh = privateSweep({ mode: "dry", log: recordingLog(), deps: deps({ cursor: fileCursorStore(file) }) });
        const at = listed.length;
        await fresh.runOnce();
        expect(new URL(listed[at] as string).searchParams.get("pageToken"), junk).toBeNull();
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe("the sweep's listing (B15)", () => {
  it("reads at most the pages it is given and hands back where to go on from", async () => {
    for (let i = 0; i < 350; i += 1) {
      row(i % 2 === 0 ? `sealed-thumb-${i}` : `old-sealed-thumb-${i}`, hoursAgo(60));
    }

    const first = await listPrivatePage(undefined);
    expect(PRIVATE_SWEEP_PAGES).toBe(2);
    expect(listed).toHaveLength(2);
    expect(first.files).toHaveLength(200);
    expect(first.next).toBe("200");

    const rest = await listPrivatePage(first.next, 5);
    expect(rest.files).toHaveLength(150);
    expect(rest.next).toBeUndefined();
  });

  it("drops rows with no name, and throws rather than answering part of a listing when a page fails", async () => {
    row(null, hoursAgo(60));
    row("sealed-thumb-a", hoursAgo(60));
    expect((await listPrivatePage(undefined)).files.map((file) => file.name)).toEqual(["sealed-thumb-a"]);

    for (let i = 0; i < 150; i += 1) {
      row(`sealed-thumb-${i}`, hoursAgo(60));
    }
    failAt.add(100);
    await expect(listPrivatePage(undefined)).rejects.toThrow(/cannot tell/);
  });
});
