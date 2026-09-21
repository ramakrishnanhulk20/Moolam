import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The copy this order adds, counted in every language.
 *
 * A key written in English only leaves nine languages reading the key itself
 * where the sentence should be, and next-intl says nothing about it. So the
 * English tree is the list, every file on disk is counted against it, and the
 * count is printed: ten for each key.
 */

const locales = readdirSync("messages")
  .filter((name) => name.endsWith(".json"))
  .map((name) => name.replace(".json", ""));

type Tree = Record<string, unknown>;

/** The long dash Ram's house rules ban, built from its code point so this file does not carry one. */
const LONG_DASH = String.fromCodePoint(0x2014);

function read(locale: string): Tree {
  return JSON.parse(readFileSync(`messages/${locale}.json`, "utf8")) as Tree;
}

function at(tree: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => (node as Tree | undefined)?.[key], tree);
}

/** The {names} an ICU string carries, so a dropped one is a failure and not a vaguer sentence. */
function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)[},]/g)].map((found) => found[1]).sort();
}

const KEYS = [
  "verify.samples",
  "verify.sampleFailed",
  "verify.recheck.label",
  "verify.recheck.never",
  "verify.recheck.count",
  "verify.recheck.none",
  "verify.recheck.noneNote",
  "verify.recheck.matched",
  "verify.recheck.mismatched",
  "verify.recheck.link",
  "verify.dispute.none",
  "verify.dispute.open",
  "verify.dispute.upheld",
  "verify.dispute.rejected",
  "story.tryIt.openPassport",
  "story.skip",
];

const en = read("en");
const files = new Map(locales.map((locale) => [locale, read(locale)]));

describe("the samples and second opinion copy in every language", () => {
  it("is ten message files", () => {
    expect(locales.length).toBe(10);
  });

  it("carries every new key in all ten, and says so", () => {
    const counted: string[] = [];

    for (const key of KEYS) {
      let found = 0;
      for (const [locale, tree] of files) {
        const value = at(tree, key);
        expect(typeof value, `${locale}.${key}`).toBe("string");
        expect((value as string).trim().length, `${locale}.${key}`).toBeGreaterThan(0);
        found += 1;
      }
      counted.push(`${key} ${found}`);
      expect(found, key).toBe(10);
    }

    console.log(counted.join("\n"));
    console.log(`${KEYS.length} new keys, each in ${locales.length} message files`);
  });

  it("keeps the day and the distance in every language, so no sentence goes vague", () => {
    for (const key of KEYS) {
      const wanted = placeholders(at(en, key) as string);
      for (const [locale, tree] of files) {
        expect(placeholders(at(tree, key) as string), `${locale}.${key}`).toEqual(wanted);
      }
    }

    expect(placeholders(at(en, "verify.recheck.matched") as string)).toEqual(["at", "count"]);
  });

  it("has none of the long dash in any language", () => {
    for (const key of KEYS) {
      for (const [locale, tree] of files) {
        expect(at(tree, key) as string, `${locale}.${key}`).not.toContain(LONG_DASH);
      }
    }
  });

  it("names Chainlink in the line that says who re-checked, in all ten", () => {
    for (const [locale, tree] of files) {
      expect(at(tree, "verify.recheck.matched") as string, locale).toContain("Chainlink");
      expect(at(tree, "verify.recheck.mismatched") as string, locale).toContain("Chainlink");
    }
  });

  it("writes each language in its own words, not in English", () => {
    for (const locale of ["ta", "hi", "zh", "ja", "ko"]) {
      const line = at(files.get(locale), "verify.recheck.none") as string;
      expect(at(files.get(locale), "verify.dispute.open") as string, locale).not.toBe(at(en, "verify.dispute.open"));
      expect(line, locale).not.toBe(at(en, "verify.recheck.none"));
      expect(line, locale).toMatch(/[^ -]/);
      expect(at(files.get(locale), "story.skip") as string, locale).not.toBe(at(en, "story.skip"));
    }
  });
});
