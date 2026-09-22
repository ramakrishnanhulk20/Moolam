import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RECHECK_KEYS, RECHECK_PLACEHOLDERS } from "./recheck-keys.mjs";

/**
 * The words on the re-check button, counted in every language the site speaks.
 *
 * A control that appears on two of the most read screens in the app cannot be
 * English in nine of them. Each line is also checked for the placeholders it
 * cannot be translated without: a queue position with no {position} in it would
 * print a sentence that says nothing, in a language nobody here can read back.
 */

const MESSAGES = fileURLToPath(new URL("../messages/", import.meta.url));

const locales = readdirSync(MESSAGES)
  .filter((name) => name.endsWith(".json"))
  .map((name) => name.replace(".json", ""));

type Tree = Record<string, unknown>;

const files = new Map<string, Tree>(
  locales.map((locale) => [locale, JSON.parse(readFileSync(`${MESSAGES}${locale}.json`, "utf8")) as Tree]),
);

function at(locale: string, path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => (node as Tree | undefined)?.[key], files.get(locale));
}

describe("the re-check control's copy", () => {
  it("has all ten language files", () => {
    expect(locales).toHaveLength(10);
  });

  for (const key of RECHECK_KEYS) {
    it(`says ${key} in ten languages`, () => {
      const said = locales.filter((locale) => {
        const value = at(locale, key);
        return typeof value === "string" && value.trim().length > 0;
      });
      expect(said.length, `${key}: ${said.join(" ")}`).toBe(10);
    });
  }

  it("keeps every placeholder a sentence cannot be read without", () => {
    for (const [key, marks] of Object.entries(RECHECK_PLACEHOLDERS)) {
      for (const locale of locales) {
        const line = String(at(locale, key));
        for (const mark of marks as string[]) {
          expect(line, `${locale} ${key}`).toContain(mark);
        }
      }
    }
  });

  it("says the button and the note in each language's own words, not English nine times over", () => {
    for (const key of ["button", "note", "stopped", "failure.notAnswering"]) {
      const english = String(at("en", `recheck.${key}`));
      const copied = locales.filter((locale) => locale !== "en" && String(at(locale, `recheck.${key}`)) === english);
      expect(copied, `${key} left in English for: ${copied.join(" ")}`).toHaveLength(0);
    }
  });

  it("promises the three things the button has to promise, and names Chainlink and Monad", () => {
    const note = String(at("en", "recheck.note")).toLowerCase();
    expect(note).toContain("free");
    expect(note).toContain("chainlink");
    expect(note).toContain("monad");
    expect(String(at("en", "recheck.button"))).toBe("Request a re-check");
  });

  it("carries the long dash nobody here writes in no language at all", () => {
    const banned = String.fromCodePoint(0x2014);
    for (const locale of locales) {
      expect(JSON.stringify(at(locale, "recheck")).includes(banned), locale).toBe(false);
    }
  });
});
