import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The drop's check path waits for the first press.
 *
 * Lighthouse on a phone measured the home page at 79 once screen one carried
 * the drop, against 91 for the page before it, and the difference was script:
 * the answer card, the verify client and viem all came with the page for a
 * check most visitors never start. They now arrive on the first press or drop.
 *
 * The walk below is the browser's side of the page: it starts at the page,
 * steps over the server's own files, and from the first "use client" file on
 * collects every file and package a static import reaches. A type-only import
 * is erased by the compiler and ships nothing, so it is not followed. A dynamic
 * import() is where the bundler splits the code off, so it is not followed
 * either, unless the walk is told to.
 */

const web = fileURLToPath(new URL("..", import.meta.url));

function fileFor(specifier: string, from: string): string | null {
  if (!specifier.startsWith("@/") && !specifier.startsWith(".")) {
    return null;
  }
  const base = specifier.startsWith("@/") ? join(web, specifier.slice(2)) : resolve(dirname(from), specifier);
  const tries = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")];
  return tries.find((path) => existsSync(path) && /\.tsx?$/.test(path)) ?? null;
}

function packageOf(specifier: string): string {
  return specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
}

/** The imports of one file that ship code: static value imports, and dynamic ones when asked. */
function importsOf(source: string, dynamic: boolean): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/^\s*(import|export)\s+(type\s+)?[^;]*?from\s*["']([^"']+)["']/gm)) {
    if (match[2] === undefined) {
      found.push(match[3]);
    }
  }
  for (const match of source.matchAll(/^\s*import\s*["']([^"']+)["']/gm)) {
    found.push(match[1]);
  }
  if (dynamic) {
    for (const match of source.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g)) {
      found.push(match[1]);
    }
  }
  return found;
}

const isClient = (source: string) => /^\s*["']use client["']/.test(source);

/** Every file and package the browser is sent for this page, from its client boundaries down. */
function clientGraph(entry: string, dynamic = false): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const seen = new Set<string>();
  const walk = (file: string, client: boolean) => {
    const source = readFileSync(file, "utf8");
    const inClient = client || isClient(source);
    const key = `${file}|${inClient}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    if (inClient) {
      files.add(file);
    }
    for (const specifier of importsOf(source, dynamic)) {
      const next = fileFor(specifier, file);
      if (next === null) {
        if (inClient && !specifier.startsWith(".") && !specifier.startsWith("node:")) {
          packages.add(packageOf(specifier));
        }
        continue;
      }
      walk(next, inClient);
    }
  };
  walk(fileFor(entry, join(web, "x.ts")) as string, false);
  return { files, packages };
}

const HOME = "@/app/[locale]/page.tsx";
const has = (files: Set<string>, tail: string) => [...files].some((file) => file.replace(/\\/g, "/").endsWith(tail));

describe("what the home page sends the browser before anyone presses anything", () => {
  it("carries the drop itself, so the frame and the samples are there to press", () => {
    const { files } = clientGraph(HOME);
    expect(has(files, "components/home/Drop.tsx")).toBe(true);
  });

  it("carries neither viem nor the answer card, nor the verify client and lookup behind them", () => {
    const { files, packages } = clientGraph(HOME);

    expect(packages.has("viem")).toBe(false);
    expect(has(files, "components/verify/AnswerCard.tsx")).toBe(false);
    expect(has(files, "components/verify/lookup.ts")).toBe(false);
    expect(has(files, "lib/verifier/client.ts")).toBe(false);
    expect(has(files, "lib/chain/client.ts")).toBe(false);
  });

  it("reaches all of them one dynamic import away, so the walk itself is not the pass", () => {
    const { files, packages } = clientGraph(HOME, true);

    expect(packages.has("viem")).toBe(true);
    expect(has(files, "components/verify/AnswerCard.tsx")).toBe(true);
    expect(has(files, "lib/verifier/client.ts")).toBe(true);
  });

  it("finds viem and the card on the verify page, where they belong, with the same walk", () => {
    const { files, packages } = clientGraph("@/components/verify/VerifyScreen.tsx");
    expect(packages.has("viem")).toBe(true);
    expect(has(files, "components/verify/AnswerCard.tsx")).toBe(true);
  });
});
