import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SEALED_KEYS, countsBySaying } from "./sealed-keys.mjs";
import { SEALED_PUBLIC_FIELDS } from "@/components/sealed/fields";

/**
 * Every word this order added, counted in every language, and checked for the
 * two things a translation can quietly break: a missing placeholder, and the
 * long dash this repo does not allow anywhere.
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

describe("the sealed copy, counted", () => {
  it("has all ten language files", () => {
    expect(locales).toHaveLength(10);
  });

  it("says every one of its keys in ten languages", () => {
    const short = countsBySaying().filter((row) => row.count !== 10);
    expect(short.map((row) => `${row.path} (${row.count})`)).toEqual([]);
  });

  it("names one row for every field the list can draw, so no row falls back to English", () => {
    for (const field of SEALED_PUBLIC_FIELDS) {
      expect(SEALED_KEYS).toContain(`studio.sealed.fields.${field.key}.label`);
      expect(SEALED_KEYS).toContain(`studio.sealed.fields.${field.key}.line`);
    }
  });

  it("keeps the placeholders the two lines with values need", () => {
    for (const locale of locales) {
      expect(String(at(files.get(locale), "studio.sealed.plate.registered")), locale).toContain("{date}");
      expect(String(at(files.get(locale), "studio.sealed.receipt.fingerprintDetail")), locale).toContain("{manifest}");
    }
  });

  it("writes no long dash in any language", () => {
    for (const locale of locales) {
      for (const path of SEALED_KEYS) {
        expect(String(at(files.get(locale), path)), `${locale} ${path}`).not.toContain(LONG_DASH);
      }
    }
  });

  it("says something different in each language, rather than the English twice", () => {
    // The whole point of ten files. One line is enough to catch a paste.
    const said = locales.map((locale) => String(at(files.get(locale), "studio.sealed.handback.save")));
    expect(new Set(said).size).toBe(10);
  });
});
