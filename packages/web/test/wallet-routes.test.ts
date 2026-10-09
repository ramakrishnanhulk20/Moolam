import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const web = fileURLToPath(new URL("..", import.meta.url));

/** The packages that only a screen which signs has any use for. */
const WALLET = ["@privy-io/react-auth", "@privy-io/wagmi", "wagmi", "@tanstack/react-query"];

const SIGNING = [
  "@/app/[locale]/studio/page.tsx",
  "@/app/[locale]/resolve/page.tsx",
  "@/app/[locale]/mine/page.tsx",
];

const READING = [
  "@/app/[locale]/page.tsx",
  "@/app/[locale]/explore/page.tsx",
  "@/app/[locale]/explore/view/page.tsx",
  "@/app/[locale]/agents/page.tsx",
  "@/app/[locale]/agent/[id]/page.tsx",
  "@/app/[locale]/verify/page.tsx",
  "@/app/[locale]/docs/[[...slug]]/page.tsx",
  "@/app/[locale]/docs/layout.tsx",
];

const IMPORT = /(?:from\s*|import\s*\(\s*)["']([^"']+)["']/g;

/**
 * The same, minus every `import(` expression: what a route pulls in before it
 * renders anything, as against what it may fetch later on its own.
 */
const STATIC_ONLY = /from\s*["']([^"']+)["']/g;

/**
 * The file a specifier points at, or null when it leaves this app: a package,
 * a stylesheet, a data file.
 */
function fileFor(specifier: string, from: string): string | null {
  if (!specifier.startsWith("@/") && !specifier.startsWith(".")) {
    return null;
  }

  const base = specifier.startsWith("@/") ? join(web, specifier.slice(2)) : resolve(dirname(from), specifier);
  const tries = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")];
  const found = tries.find((path) => existsSync(path) && /\.tsx?$/.test(path));
  return found ?? null;
}

/**
 * Every package that reaches the browser from one route.
 *
 * The walk turns browser side the moment it enters a file marked "use client",
 * because from there down everything the file imports is shipped and run in the
 * page. Server only modules above that line cost the reader nothing, which is
 * why viem is not a finding on a page that reads the chain while it renders.
 */
function browserPackages(entry: string, imports: RegExp = IMPORT): Set<string> {
  const packages = new Set<string>();
  const seen = new Set<string>();

  const walk = (file: string, client: boolean) => {
    const key = `${file}::${String(client)}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);

    const source = readFileSync(file, "utf8");
    const shipped = client || /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use client["']/.test(source);

    for (const match of source.matchAll(imports)) {
      const specifier = match[1];
      const next = fileFor(specifier, file);
      if (next === null) {
        if (shipped && !specifier.startsWith("@/") && !specifier.startsWith(".") && !specifier.startsWith("node:")) {
          packages.add(specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]);
        }
        continue;
      }
      walk(next, shipped);
    }
  };

  const start = fileFor(entry, join(web, "x.ts"));
  expect(start, `${entry} should exist`).not.toBeNull();
  walk(start as string, false);
  return packages;
}

describe("which routes carry the wallet", () => {
  it.each(READING)("%s ships no wallet SDK", (entry) => {
    const packages = browserPackages(entry);
    expect([...packages].filter((name) => WALLET.includes(name))).toEqual([]);
  });

  it.each(SIGNING)("%s still has the wallet", (entry) => {
    expect(browserPackages(entry)).toContain("@privy-io/react-auth");
  });

  it("keeps the provider out of the layout every page shares", () => {
    const layout = readFileSync(join(web, "app/[locale]/layout.tsx"), "utf8");
    expect(layout).not.toContain("PrivyProvider");
  });

  // The layout holds the wallet host, which keeps the SDK mounted once a signing page has asked for
  // it, so the SDK is one dynamic import away from every page and in none of their first scripts.
  it("ships no wallet SDK from the layout every page shares, before any dynamic import", () => {
    const packages = browserPackages("@/app/[locale]/layout.tsx", STATIC_ONLY);
    expect([...packages].filter((name) => WALLET.includes(name))).toEqual([]);
  });

  it("finds the wallet when it is there, so the walk itself is not the pass", () => {
    expect(browserPackages("@/components/providers/PrivyProvider.tsx")).toContain("@privy-io/react-auth");
  });
});

describe("what a passport page carries before its reader signs in", () => {
  const PASSPORT = "@/app/[locale]/passport/[id]/page.tsx";

  it("reaches no wallet package without following a dynamic import", () => {
    const packages = browserPackages(PASSPORT, STATIC_ONLY);
    expect([...packages].filter((name) => WALLET.includes(name))).toEqual([]);
  });

  it("keeps the wallet behind the two panels, one dynamic import away", () => {
    expect(browserPackages(PASSPORT)).toContain("@privy-io/react-auth");
  });

  // The studio and /mine used to be the control here. Now they fetch
  // their Privy hooks beside the SDK, one dynamic import away, so the resolve
  // console is the route that still names the wallet statically.
  it("reaches the wallet statically from the resolve console, so the static walk is not the pass", () => {
    expect(browserPackages("@/app/[locale]/resolve/page.tsx", STATIC_ONLY)).toContain("@privy-io/react-auth");
  });
});
