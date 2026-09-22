import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SEALED_PAGE_KEYS, countsBySaying } from "./sealed-page-keys.mjs";

/**
 * The words this order added, counted in every language, and checked for the
 * three things a translation can quietly break: a missing placeholder, the long
 * dash this repo does not allow anywhere, and one language file pasted into
 * another.
 */

const MESSAGES = fileURLToPath(new URL("../messages/", import.meta.url));
const locales = readdirSync(MESSAGES)
  .filter((name) => name.endsWith(".json"))
  .map((name) => name.replace(".json", ""));

/** The character the house rule bans, built rather than typed. */
const LONG_DASH = String.fromCharCode(0x2014);

function read(locale: string): Record<string, unknown> {
  return JSON.parse(readFileSync(`${MESSAGES}${locale}.json`, "utf8")) as Record<string, unknown>;
}

function at(tree: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], tree);
}

const files = new Map(locales.map((locale) => [locale, read(locale)]));

describe("the sealed copy on the passport page, Explore and verify", () => {
  it("has all ten language files", () => {
    expect(locales).toHaveLength(10);
  });

  it("says every one of its keys in ten languages", () => {
    const short = countsBySaying().filter((row) => row.count !== 10);
    expect(short.map((row) => `${row.path} (${row.count})`)).toEqual([]);
  });

  it("keeps the placeholders the two lines with values need", () => {
    for (const locale of locales) {
      expect(String(at(files.get(locale), "passport.sealed.posterLine")), locale).toContain("{date}");
      expect(String(at(files.get(locale), "passport.sealed.commitmentAlgorithm")), locale).toContain("{algorithm}");
    }
  });

  it("writes no long dash in any language", () => {
    for (const locale of locales) {
      for (const path of SEALED_PAGE_KEYS) {
        expect(String(at(files.get(locale), path)), `${locale} ${path}`).not.toContain(LONG_DASH);
      }
    }
  });

  it("says something different in each language, rather than the English ten times", () => {
    const said = locales.map((locale) => String(at(files.get(locale), "verify.sealed.matched")));
    expect(new Set(said).size).toBe(10);
  });

  it("never calls a sealed record broken, unavailable or not re-checked yet", () => {
    // The three sentences that belong to a gateway having a bad minute. A
    // sealed record must never be handed any of them, in any language.
    const faults = ["passport.noPicture", "explore.noPicture", "passport.standing.unverified"];

    for (const locale of locales) {
      const tree = files.get(locale);
      const sealedWords = SEALED_PAGE_KEYS.map((path) => String(at(tree, path)));
      for (const fault of faults) {
        expect(sealedWords, `${locale} ${fault}`).not.toContain(String(at(tree, fault)));
      }
    }
  });
});
