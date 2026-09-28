import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  emptyState,
  inCooldown,
  loadState,
  noteRecent,
  noteUndecided,
  noteWaiting,
  rollDay,
  saveState,
  undecidedUntil,
  utcDay,
  waitFor,
} from "../src/state.js";

const folders: string[] = [];

function scratch(): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "moolam-runner-"));
  folders.push(folder);
  return path.join(folder, "runner-state.json");
}

afterEach(() => {
  for (const folder of folders.splice(0)) {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

const NOON = Date.parse("2026-09-22T12:00:00Z");

describe("the spend ledger on disk", () => {
  it("starts an empty day when there is no file yet", () => {
    const state = loadState(scratch(), NOON);
    expect(state).toEqual(emptyState("2026-09-22"));
  });

  it("starts an empty day rather than stopping when the file is corrupt", () => {
    const file = scratch();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ half a fi", "utf8");
    expect(loadState(file, NOON).reports).toBe(0);
  });

  it("reads a day's count that is not a whole number as the cap used up, never as room to spend (R9)", () => {
    for (const reports of ['"abc"', "-5", "1.5", "null", '"12"', "1e400"]) {
      const file = scratch();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `{ "day": "2026-09-22", "reports": ${reports} }`, "utf8");
      const state = loadState(file, NOON);
      expect(state.reports).toBe(Number.MAX_SAFE_INTEGER);
      expect(state.reports >= 40).toBe(true);
    }
  });

  it("still gives the cap back on the next UTC day after a bad count", () => {
    const file = scratch();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ "day": "2026-09-21", "reports": "abc" }', "utf8");
    expect(loadState(file, NOON).reports).toBe(0);
  });

  it("writes through a temporary name, so a crash mid-write leaves the old file whole", () => {
    const file = scratch();
    saveState(file, { ...emptyState("2026-09-22"), reports: 7 });
    expect(loadState(file, NOON).reports).toBe(7);
    expect(fs.existsSync(`${file}.writing`)).toBe(false);

    // What a machine that died mid-write leaves behind: the temporary file, and the old one intact.
    fs.writeFileSync(`${file}.writing`, "{ half", "utf8");
    expect(loadState(file, NOON).reports).toBe(7);
    saveState(file, { ...emptyState("2026-09-22"), reports: 8 });
    expect(loadState(file, NOON).reports).toBe(8);
  });

  it("reads a file written before the settled maps existed, and drops entries of the wrong shape", () => {
    const file = scratch();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const id = `0x${"a".repeat(64)}`;
    fs.writeFileSync(
      file,
      JSON.stringify({
        day: "2026-09-22",
        reports: 3,
        recent: { [id]: 1_789_000_000, bad: "soon" },
        closed: { [id]: { at: 1_789_000_000, reason: "its metadata names no thumbnail or image to check" }, other: "closed" },
        waiting: { [id]: { until: 1 } },
      }),
      "utf8",
    );
    const state = loadState(file, NOON);
    expect(state.reports).toBe(3);
    expect(state.recent).toEqual({ [id]: 1_789_000_000 });
    expect(Object.keys(state.closed)).toEqual([id]);
    expect(state).toMatchObject({ held: {}, waiting: {}, refusals: {}, sent: {}, undecided: {} });
  });

  it("reads a tripped breaker it cannot make sense of as tripped, never as clear", () => {
    const file = scratch();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ day: "2026-09-22", reports: 0, breaker: { streak: [], tripped: "yes" } }), "utf8");
    expect(loadState(file, NOON).breaker.tripped).not.toBeNull();
    fs.writeFileSync(file, JSON.stringify({ day: "2026-09-22", reports: 0 }), "utf8");
    expect(loadState(file, NOON).breaker).toEqual({ streak: [], tripped: null });
  });

  it("gives the cap back on a new UTC day and keeps everything else", () => {
    const yesterday = { ...emptyState("2026-09-21"), reports: 40, failures: 2, backoffUntil: 99 };
    const rolled = rollDay(yesterday, NOON);
    expect(rolled.day).toBe("2026-09-22");
    expect(rolled.reports).toBe(0);
    expect(rolled.failures).toBe(2);
    expect(rolled.backoffUntil).toBe(99);
  });

  it("leaves the count alone inside the same day", () => {
    const today = { ...emptyState("2026-09-22"), reports: 12 };
    expect(rollDay(today, NOON).reports).toBe(12);
    expect(utcDay(NOON)).toBe("2026-09-22");
  });
});

describe("leaving a passport alone after it was handled", () => {
  const id = `0x${"a".repeat(64)}`;

  it("holds a passport for the cooldown and lets it go after", () => {
    const state = noteRecent(emptyState("2026-09-22"), id, NOON);
    expect(inCooldown(state, id, NOON + 60_000, 600)).toBe(true);
    expect(inCooldown(state, id.toUpperCase(), NOON + 60_000, 600)).toBe(true);
    expect(inCooldown(state, id, NOON + 900_000, 600)).toBe(false);
  });

  it("doubles a passing wait with each miss in a row, up to the cooldown (tally R5)", () => {
    let state = emptyState("2026-09-22");
    const waits: number[] = [];
    for (let miss = 0; miss < 7; miss += 1) {
      state = noteWaiting(state, id, "the gateway did not answer", NOON, 600, 21_600);
      waits.push((state.waiting[id]?.until ?? 0) - NOON / 1000);
    }
    expect(waits).toEqual([600, 1_200, 2_400, 4_800, 9_600, 19_200, 21_600]);
    expect(waitFor(state, id, NOON + 21_599_000)).toBeDefined();
    expect(waitFor(state, id, NOON + 21_600_000)).toBeUndefined();
  });

  it("holds an undecided run for the cooldown, across a restart, and lets it go after", () => {
    const file = scratch();
    const noted = noteUndecided(noteWaiting(emptyState("2026-09-22"), id, "the gateway did not answer", NOON, 600, 21_600), id, NOON);
    expect(noted.waiting[id]).toBeUndefined();
    saveState(file, noted);
    const state = loadState(file, NOON);
    expect(undecidedUntil(state, id.toUpperCase().replace("0X", "0x"), NOON + 60_000, 21_600)).toBe(NOON / 1000 + 21_600);
    expect(undecidedUntil(state, id, NOON + 21_600_000, 21_600)).toBeUndefined();
    expect(undecidedUntil(emptyState("2026-09-22"), id, NOON, 21_600)).toBeUndefined();
  });

  it("says nothing about a passport it has never seen", () => {
    expect(inCooldown(emptyState("2026-09-22"), id, NOON, 600)).toBe(false);
  });

  it("keeps the list bounded, dropping the oldest first", () => {
    let state = emptyState("2026-09-22");
    for (let index = 0; index < 520; index += 1) {
      state = noteRecent(state, `0x${index.toString(16).padStart(64, "0")}`, NOON + index * 1000);
    }
    expect(Object.keys(state.recent)).toHaveLength(500);
    expect(state.recent[`0x${(0).toString(16).padStart(64, "0")}`]).toBeUndefined();
    expect(state.recent[`0x${(519).toString(16).padStart(64, "0")}`]).toBeDefined();
  });
});
