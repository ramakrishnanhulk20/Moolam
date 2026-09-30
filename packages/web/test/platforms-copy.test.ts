import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadPlatforms } from "@/lib/platforms/platforms";

/**
 * lib/platforms is a copy of packages/verifier/src/platforms, written by the
 * verifier's platforms:sync script, because neither deploy can reach the other
 * package. This holds the two to the same bytes, file for file, so the site and
 * the verify service can never label a passport by two different lists or two
 * different rules.
 *
 * Does not cover the loader's rules themselves; the verifier's platforms.test.ts
 * does. It does not prove the deployed site is running the committed copy.
 */

const source = fileURLToPath(new URL("../../verifier/src/platforms/", import.meta.url));
const copy = fileURLToPath(new URL("../lib/platforms/", import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

describe("the web copy of the platform list", () => {
  it("holds exactly the files the verifier's folder holds", () => {
    expect(files(copy)).toEqual(files(source));
    expect(files(source)).toContain("platforms.json");
  });

  it.each(files(source))("matches %s byte for byte", (name) => {
    expect(readFileSync(`${copy}${name}`).equals(readFileSync(`${source}${name}`))).toBe(true);
  });

  it("loads through the site's own module resolution", async () => {
    expect((await loadPlatforms()).ok).toBe(true);
  });
});
