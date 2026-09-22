import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
// @ts-expect-error the counting script is plain JavaScript on purpose, so a person can run it
import { UNSEAL_KEYS, countsBySaying } from "./unseal-keys.mjs";

/**
 * Every sentence the publish control can print, in every language the site has.
 *
 * A refusal that falls back to English is the moment the app stops being the
 * reader's, and this one is a screen about giving up a picture for ever. The
 * placeholders are checked too: a sentence that lost its {date} reads as a
 * sentence with a hole in it.
 */

const MESSAGES = fileURLToPath(new URL("../messages/", import.meta.url));

/** The long dash, written as a code point so this file does not contain one. */
const LONG_DASH = String.fromCharCode(0x2014);

const locales = readdirSync(MESSAGES)
  .filter((name) => name.endsWith(".json"))
  .map((name) => name.replace(".json", ""));

const trees = new Map(
  locales.map((locale) => [locale, JSON.parse(readFileSync(`${MESSAGES}${locale}.json`, "utf8")) as unknown]),
);

function at(locale: string, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (node, key) => (node === undefined || node === null ? undefined : (node as Record<string, unknown>)[key]),
      trees.get(locale),
    );
}

describe("the copy this control needs", () => {
  it("has ten languages to check, which is every one the site ships", () => {
    expect([...locales].sort()).toEqual(["de", "en", "es", "fr", "hi", "ja", "ko", "pt", "ta", "zh"]);
  });

  it("says every key in all ten, with nothing left in English by accident", () => {
    const short = (countsBySaying() as { path: string; count: number }[]).filter((row) => row.count !== 10);
    expect(short).toEqual([]);
  });

  it("keeps every placeholder in every language", () => {
    const placeholders: [string, string[]][] = [
      ["passport.unseal.matchedLine", ["{id}"]],
      ["passport.unseal.allowance", ["{used}", "{limit}"]],
      ["passport.unseal.done.at", ["{when}"]],
      ["passport.unseal.failure.quota", ["{used}", "{limit}", "{at}"]],
      ["passport.unsealed.poster", ["{date}"]],
      ["passport.unsealed.line", ["{date}"]],
      ["verify.unsealed.matched", ["{date}"]],
    ];

    for (const [path, names] of placeholders) {
      for (const locale of locales) {
        const said = at(locale, path) as string;
        for (const name of names) {
          expect(said, `${locale} ${path}`).toContain(name);
        }
      }
    }
  });

  it("says the one thing that cannot be taken back, in every language", () => {
    // No translation of this screen may quietly drop the warning: it is the
    // only sentence on it that a holder cannot learn again afterwards.
    for (const locale of locales) {
      const permanent = at(locale, "passport.unseal.permanent") as string;
      // Counted in characters, so the bar is what a short script needs rather
      // than what a Latin one does: the Chinese line says all of it in 28.
      expect(permanent.length, locale).toBeGreaterThan(20);
    }
  });

  it("writes no long dash anywhere in the new copy", () => {
    for (const locale of locales) {
      for (const path of UNSEAL_KEYS as string[]) {
        expect(at(locale, path) as string, `${locale} ${path}`).not.toContain(LONG_DASH);
      }
    }
  });
});
