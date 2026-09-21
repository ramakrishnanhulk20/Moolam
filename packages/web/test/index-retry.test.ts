import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { RETRY_LIMIT, RETRY_WAITS, isRateLimited, tick, waitBefore } from "@/components/retryPlan";

/**
 * The schedule a page follows after the index would not answer it.
 *
 * On 2026-09-21 a reader met "the Envio endpoint answered 429" on Explore and
 * on Agents, six renders in a row, with nothing on the page to press. These
 * hold the three things that make the way back safe rather than a second wave
 * of traffic at an endpoint that has just asked for room.
 */

const waits = (rateLimited: boolean) =>
  [...Array(RETRY_LIMIT + 2).keys()].map((tried) => waitBefore(tried, rateLimited));

describe("how long the page waits before trying again", () => {
  it("waits five seconds, then ten, then twenty, and then stops", () => {
    expect(waits(false)).toEqual([5, 10, 20, null, null]);
    expect(RETRY_WAITS).toEqual([5, 10, 20]);
  });

  it("starts at ten after a 429, because that answer is the index asking for room", () => {
    expect(isRateLimited("the Envio endpoint answered 429")).toBe(true);
    expect(waits(true)).toEqual([10, 20, 40, null, null]);
  });

  it("reads a rate limit off the endpoint's own words and nothing else", () => {
    expect(isRateLimited("Too Many Requests")).toBe(true);
    expect(isRateLimited("the Envio endpoint answered 502")).toBe(false);
    expect(isRateLimited("the Envio endpoint returned no data block")).toBe(false);
    // A 429 inside a longer number is some other endpoint's id, not a status.
    expect(isRateLimited("passport 0x4291 could not be read")).toBe(false);
  });

  it("gives three tries whatever the failure was, so a page can never ask forever", () => {
    expect(waitBefore(RETRY_LIMIT, false)).toBeNull();
    expect(waitBefore(RETRY_LIMIT, true)).toBeNull();
    expect(waitBefore(-1, false)).toBeNull();
    expect(RETRY_LIMIT).toBe(3);
  });
});

/**
 * A line written in English only would leave nine languages with a countdown
 * that says nothing, on the one screen where the reader is already stuck.
 */
describe("the way back is written in every language", () => {
  const added = [
    "retry.countdown",
    "retry.now",
    "retry.trying",
    "retry.stopped",
    "explore.reading",
    "explore.legend.manifest",
    "explore.legend.rechecked",
    "explore.legend.disputed",
    "agents.scoreMeaning",
    "agents.formulaHow",
    "agents.formulaDoc",
  ];

  // Read off the folder rather than the routing table: the table pulls in
  // next/navigation, and the point here is that every file on disk carries the
  // keys.
  const locales = readdirSync("messages")
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.replace(".json", ""));

  const words = (locale: string, path: string): unknown =>
    path
      .split(".")
      .reduce<unknown>(
        (at, key) => (at === undefined ? undefined : (at as Record<string, unknown>)[key]),
        JSON.parse(readFileSync(`messages/${locale}.json`, "utf8")) as unknown,
      );

  it("is ten languages", () => {
    expect(locales.length).toBe(10);
  });

  for (const locale of locales) {
    it(`${locale} carries every new line, in its own words`, () => {
      for (const key of added) {
        const said = words(locale, key);
        expect(said, `${locale}.${key}`).toBeTypeOf("string");
        expect((said as string).trim().length, `${locale}.${key}`).toBeGreaterThan(0);
      }
      // The countdown has to carry the number it is counting down.
      expect(words(locale, "retry.countdown")).toContain("{seconds");
      // The formula was the first thing on the agents page and is now under a
      // disclosure, so the link that led to the docs has a name of its own.
      expect(words(locale, "agents.formulaLink")).toBeUndefined();
    });
  }
});

describe("the countdown itself", () => {
  it("holds where it is while the tab is hidden, so a page nobody is looking at asks nothing", () => {
    expect(tick(5, false)).toBe(5);
    expect(tick(1, false)).toBe(1);
  });

  it("counts down a second at a time while the tab is on screen", () => {
    expect(tick(5, true)).toBe(4);
    expect(tick(1, true)).toBe(0);
  });

  it("never runs past zero, which is the moment one try is made", () => {
    expect(tick(0, true)).toBe(0);
  });

  it("reaches zero on the visible seconds alone, however long the tab was away", () => {
    const wait = waitBefore(0, true) ?? 0;
    let left = wait;
    let watched = 0;

    // A hundred seconds with the tab hidden move it nowhere.
    for (let second = 0; second < 100; second += 1) {
      left = tick(left, false);
    }
    expect(left).toBe(wait);

    while (left > 0) {
      left = tick(left, true);
      watched += 1;
    }
    expect(watched).toBe(wait);
  });
});
