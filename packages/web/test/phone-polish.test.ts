import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { phashWord } from "@/lib/chain/fingerprint";

/**
 * The phone pass of 2026-09-15: the readings a thumb could not use.
 *
 * Two of those fixes are things a test can hold on to. The rest are layout and
 * hit areas, measured in a browser at 375x812 and written down in the work
 * order's report.
 */

describe("a re-check's pHash is read at the length it has before it is drawn", () => {
  it("drops the padding a bytes32 slot adds to a 64 bit fingerprint", () => {
    expect(phashWord(`0x${"0".repeat(48)}8f1c2d3e4a5b6c7d`)).toBe(0x8f1c2d3e4a5b6c7dn);
  });

  it("reads a zero fingerprint as zero", () => {
    expect(phashWord(`0x${"0".repeat(64)}`)).toBe(0n);
  });

  it("leaves a value with something in the upper bytes whole, since it is not a padded pHash", () => {
    const full = `0x${"9".repeat(64)}`;
    expect(phashWord(full)).toBe(BigInt(full));
  });

  it("leaves a value that is not thirty two bytes alone", () => {
    expect(phashWord("0x8f1c2d3e4a5b6c7d")).toBe(0x8f1c2d3e4a5b6c7dn);
  });
});

/**
 * The drop panel's invitation and the theme chip's label were rewritten for a
 * phone, where nobody drags anything and the chip sits beside one that names
 * the current language. A key rewritten in English only would leave nine
 * languages reading the old sentence, or nothing at all.
 */
describe("the copy the phone pass rewrote is in every language", () => {
  const changed = [
    ["verify", "dropTitle"],
    ["header", "themeDark"],
    ["header", "themeLight"],
  ] as const;

  // Read off the folder rather than the routing table: the table pulls in
  // next/navigation, and the point here is that every file on disk carries the
  // keys.
  const locales = readdirSync("messages").filter((name) => name.endsWith(".json")).map((name) => name.replace(".json", ""));

  it("is ten languages", () => {
    expect(locales.length).toBe(10);
  });

  for (const locale of locales) {
    it(`${locale} carries all three`, () => {
      const messages = JSON.parse(readFileSync(`messages/${locale}.json`, "utf8")) as Record<
        string,
        Record<string, string>
      >;
      for (const [namespace, key] of changed) {
        expect(messages[namespace]?.[key], `${locale}.${namespace}.${key}`).toBeTypeOf("string");
        expect(messages[namespace][key].trim().length).toBeGreaterThan(0);
      }
    });
  }
});
