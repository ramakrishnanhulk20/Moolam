// Covers review pass 9, V77: turns at the fair gate go round the callers, so two callers flooding
// the verify lane cannot push everyone else to the edge of the wait. The reviewer's shape, scaled
// down: two callers each send a two-turn request every 50 ms, and a stream of new callers each
// send one. The gate is the real fairGate, run in memory with short tasks and a short wait.
// Does NOT cover the gate inside the server (test/fair-limits.test.ts drives it through /verify),
// the studio lane's reserved slot, or how long real matches take.

import { describe, expect, it } from "vitest";
import { Busy, fairGate } from "../src/generate/gate.js";

const TASK_MS = 100;
const WAIT_MS = 1_500;
const FLOOD_EVERY_MS = 50;
const NEWCOMER_EVERY_MS = 200;
const NEWCOMERS = 12;

async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

/**
 * Sends one newcomer every NEWCOMER_EVERY_MS, each a two-turn request as verifyBytes makes, while
 * `flooders` each send one every FLOOD_EVERY_MS. Answers each newcomer's wait, the time it spent
 * beyond its two tasks, or "busy" when the gate turned it away.
 */
async function newcomerWaits(flooders: string[]): Promise<(number | "busy")[]> {
  const gate = fairGate({ verifySlots: 2, studioSlots: 1, maxWaitMs: WAIT_MS });
  const twoTurns = async (caller: string): Promise<void> => {
    await gate("verify", caller, () => pause(TASK_MS));
    await gate("verify", caller, () => pause(TASK_MS));
  };

  let flooding = true;
  const flood: Promise<unknown>[] = [];
  const floods = flooders.map(async (caller) => {
    while (flooding) {
      flood.push(twoTurns(caller).catch((error: unknown) => error));
      await pause(FLOOD_EVERY_MS);
    }
  });

  // Long enough for both flooders to build the backlog the reviewer measured.
  await pause(flooders.length === 0 ? 0 : WAIT_MS);
  const newcomers: Promise<number | "busy">[] = [];
  for (let index = 0; index < NEWCOMERS; index += 1) {
    const started = performance.now();
    newcomers.push(
      twoTurns(`newcomer-${index}`).then(
        () => performance.now() - started - 2 * TASK_MS,
        (error: unknown) => {
          if (error instanceof Busy) return "busy" as const;
          throw error;
        },
      ),
    );
    await pause(NEWCOMER_EVERY_MS);
  }

  const waits = await Promise.all(newcomers);
  flooding = false;
  await Promise.all(floods);
  await Promise.allSettled(flood);
  return waits;
}

describe("V77: the fair gate takes callers in turn", () => {
  it("keeps a new caller's wait near the unflooded wait while two callers flood the verify lane", async () => {
    const calm = await newcomerWaits([]);
    const flooded = await newcomerWaits(["flooder-a", "flooder-b"]);

    expect(calm).not.toContain("busy");
    expect(flooded, `waits under the flood: ${flooded.map((wait) => (wait === "busy" ? wait : Math.round(wait))).join(", ")}`).not.toContain("busy");
    const calmMedian = median(calm as number[]);
    const floodedMedian = median(flooded as number[]);
    // One task of each of the two turns is the most a newcomer should wait for a turn in progress.
    expect(floodedMedian).toBeLessThan(calmMedian + 2 * TASK_MS + 50);
  }, 30_000);

  it("still runs one caller's turns one at a time and never loses a waiter", async () => {
    const gate = fairGate({ verifySlots: 2, studioSlots: 1, maxWaitMs: WAIT_MS });
    let running = 0;
    let most = 0;
    const task = async (): Promise<void> => {
      running += 1;
      most = Math.max(most, running);
      await pause(20);
      running -= 1;
    };

    await Promise.all(Array.from({ length: 6 }, () => gate("verify", "one-caller", task)));

    expect(most).toBe(1);
  });
});
