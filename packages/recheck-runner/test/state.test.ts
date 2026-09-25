import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyState, inCooldown, loadState, noteRecent, rollDay, saveState, utcDay } from "../src/state.js";

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
