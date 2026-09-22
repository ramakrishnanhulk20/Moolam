import { describe, expect, it } from "vitest";
import { guideKeys } from "@/components/guide/steps";
import { GUIDE_KEYS, countsBySaying, untranslated, valueAt } from "./guide-keys.mjs";

/**
 * The guide speaks ten languages or it does not ship.
 *
 * A first visitor reading the site in Tamil or Japanese is exactly the person
 * this thing exists for, so an English sentence left in one of those files is
 * worse than no guide at all. The walk asks for its words by key; these are the
 * keys, counted in every file there is.
 */

const LOCALES = ["en", "ta", "hi", "zh", "ja", "ko", "es", "fr", "de", "pt"];

/** The long dash Ram's house rules ban, built from its code point so this file carries none. */
const LONG_DASH = String.fromCodePoint(0x2014);

describe("the guide's words", () => {
  it("asks for exactly the keys the count script checks", () => {
    expect(GUIDE_KEYS).toEqual(guideKeys());
  });

  it("is said in all ten languages, every key", () => {
    expect(countsBySaying().filter((row: { count: number }) => row.count !== 10)).toEqual([]);
  });

  it("is really translated, not the English pasted nine times", () => {
    for (const key of GUIDE_KEYS) {
      expect({ key, same: untranslated(key) }).toEqual({ key, same: [] });
    }
  });

  it("keeps both figures in the step counter, so nobody reads 1 of undefined", () => {
    for (const locale of LOCALES) {
      const counter = valueAt(locale, "guide.step") as string;
      expect(counter).toContain("{shown}");
      expect(counter).toContain("{total}");
    }
  });

  it("carries no long dash in any language", () => {
    for (const locale of LOCALES) {
      for (const key of GUIDE_KEYS) {
        expect(valueAt(locale, key)).not.toContain(LONG_DASH);
      }
    }
  });
});
