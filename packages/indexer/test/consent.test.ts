// The pure mapping from the contract's four numbers to the words the GraphQL API
// serves.
//
// NOT COVERED HERE: nothing about the handler, the schema or the chain. These are
// table tests over the enum; whether the right numbers reach them is
// handlers.test.ts, and whether the contract can even emit a number outside the
// enum is the Foundry suite in packages/contracts.

import { describe, expect, it } from "vitest";
import { summaryOf, useWord } from "../src/consent.js";

const UNSPECIFIED = 0;
const ALLOWED = 1;
const NOT_ALLOWED = 2;
const CONSTRAINED = 3;

describe("useWord", () => {
  it("names every value the contract's Use enum defines", () => {
    expect(useWord(UNSPECIFIED)).toBe("unspecified");
    expect(useWord(ALLOWED)).toBe("allowed");
    expect(useWord(NOT_ALLOWED)).toBe("notAllowed");
    expect(useWord(CONSTRAINED)).toBe("constrained");
  });

  it("refuses anything the enum does not define rather than guessing at it", () => {
    for (const value of [-1, 4, 255, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(useWord(value)).toBeNull();
    }
  });
});

describe("summaryOf", () => {
  it("gives the four single minded statements their own word", () => {
    expect(summaryOf(ALLOWED, ALLOWED, ALLOWED, ALLOWED)).toBe("open");
    expect(summaryOf(NOT_ALLOWED, NOT_ALLOWED, NOT_ALLOWED, NOT_ALLOWED)).toBe("closed");
    expect(summaryOf(CONSTRAINED, CONSTRAINED, CONSTRAINED, CONSTRAINED)).toBe("ask");
    expect(summaryOf(UNSPECIFIED, UNSPECIFIED, UNSPECIFIED, UNSPECIFIED)).toBe("none");
  });

  it("calls a statement mixed as soon as one use differs from the rest", () => {
    expect(summaryOf(ALLOWED, ALLOWED, ALLOWED, NOT_ALLOWED)).toBe("mixed");
    expect(summaryOf(NOT_ALLOWED, ALLOWED, NOT_ALLOWED, NOT_ALLOWED)).toBe("mixed");
    // Silence on one use is itself a difference: a holder who allows inference and
    // says nothing about training has not opened their picture to training.
    expect(summaryOf(UNSPECIFIED, UNSPECIFIED, ALLOWED, UNSPECIFIED)).toBe("mixed");
    expect(summaryOf(CONSTRAINED, NOT_ALLOWED, CONSTRAINED, CONSTRAINED)).toBe("mixed");
  });

  it("refuses the whole statement when any one number is outside the enum", () => {
    expect(summaryOf(ALLOWED, ALLOWED, ALLOWED, 4)).toBeNull();
    expect(summaryOf(-1, ALLOWED, ALLOWED, ALLOWED)).toBeNull();
    expect(summaryOf(UNSPECIFIED, 9, UNSPECIFIED, UNSPECIFIED)).toBeNull();
    expect(summaryOf(1.5, ALLOWED, ALLOWED, ALLOWED)).toBeNull();
  });

  it("agrees with the app's plainStatement on every combination of the enum", () => {
    // The web app reaches the same five words through
    // packages/web/lib/chain/consent.ts, which a screen and this index must never
    // disagree about. That file's branches are transcribed here in its own order,
    // then checked against summaryOf for all 256 statements the enum can express.
    const words = ["unspecified", "allowed", "notAllowed", "constrained"] as const;
    const plainStatement = (values: readonly string[]) => {
      if (values.every((use) => use === "unspecified")) return "none";
      if (values.every((use) => use === "allowed")) return "open";
      if (values.every((use) => use === "notAllowed")) return "closed";
      if (values.every((use) => use === "constrained")) return "ask";
      return "mixed";
    };

    let checked = 0;
    for (const a of [0, 1, 2, 3]) {
      for (const b of [0, 1, 2, 3]) {
        for (const c of [0, 1, 2, 3]) {
          for (const d of [0, 1, 2, 3]) {
            expect(summaryOf(a, b, c, d)).toBe(
              plainStatement([words[a]!, words[b]!, words[c]!, words[d]!]),
            );
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBe(256);
  });
});
