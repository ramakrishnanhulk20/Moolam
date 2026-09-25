import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { GONE_KEYS, SHELL_KEYS, countsBySaying, valueAt } from "./shell-keys.mjs";

/**
 * The phone bar, where it now lives: under every real page
 * on a phone, with the menu button gone.
 *
 * What is pinned down here is the shape of the roll-in rather than the bar
 * itself, which test/phone-shell.test.ts already renders: the layout draws it
 * below md and not above, every page leaves room for it, the five words exist
 * in all ten languages, and the three tabs the first-visit guide points at
 * carry the names the guide looks for.
 */

const layout = readFileSync("app/[locale]/layout.tsx", "utf8");

describe("the layout on a phone", () => {
  it("draws the short header below md and the desktop bar above it", () => {
    expect(layout).toContain('<PhoneHeader brand={t("brand")} className="app-header md:hidden" />');
    expect(layout).toMatch(/<header className="app-header sticky top-0 z-40 hidden [^"]*md:block">/);
  });

  it("draws the raised bar below md, and nothing above it", () => {
    const at = layout.indexOf("<BottomBar");
    expect(at).toBeGreaterThan(-1);
    expect(layout.slice(at - 60, at)).toContain('className="md:hidden"');
    expect(layout.slice(at, at + 160)).toContain('shape="raised"');
    expect(layout.slice(at, at + 160)).toContain('label={bar("label")}');
  });

  it("has no menu button left, and no file for one", () => {
    expect(layout).not.toContain("HeaderMenu");
    expect(existsSync("components/HeaderMenu.tsx")).toBe(false);
  });

  it("leaves the bar's room under the last thing on the page, and only where the bar is", () => {
    // On the footer rather than on main: the footer comes after main, so
    // main's own padding left the registry line behind the bar. Measured at
    // 375 before the move: the lowest element ended 57 px past the bar's top.
    expect(layout).toContain('<footer className="border-t border-line pb-[var(--bar-room)] md:pb-0">');
    const css = readFileSync("styles/globals.css", "utf8");
    expect(css).toContain("--bar-room: calc(84px + env(safe-area-inset-bottom));");
  });

  it("keeps the docs reachable from the foot of every page", () => {
    const foot = layout.slice(layout.indexOf("<footer"));
    expect(foot).toContain('<Link href="/docs"');
    expect(foot).toContain('{t("nav.docs")}');
  });

  it("carries no wallet import of its own", () => {
    expect(layout).not.toContain("@privy-io");
    expect(layout).not.toContain("wagmi");
  });
});

describe("the five tabs the layout hands the bar", () => {
  const table = layout.slice(layout.indexOf("const tabs: Tab[] = ["), layout.indexOf("];", layout.indexOf("const tabs: Tab[] = [")));

  it("reads home, explore, make, verify, mine, in that order", () => {
    expect([...table.matchAll(/key: "([a-z]+)"/g)].map((found) => found[1])).toEqual([
      "home",
      "explore",
      "make",
      "verify",
      "mine",
    ]);
  });

  it("never prefetches the two pages that carry the wallet", () => {
    expect(table.match(/prefetch: false/g)).toHaveLength(2);
    for (const key of ["make", "mine"]) {
      const at = table.indexOf(`key: "${key}"`);
      expect(table.slice(at, at + 170)).toContain("prefetch: false");
    }
  });

  it("names the three places the first-visit guide points at", () => {
    const anchors = [...table.matchAll(/anchor: "([a-z]+)"/g)].map((found) => found[1]);
    expect(anchors).toEqual(["studio", "verify", "mine"]);
  });

  it("takes every word from the message files and writes none of its own", () => {
    for (const key of ["home", "explore", "make", "verify", "mine"]) {
      expect(table).toContain(`label: bar("tabs.${key}")`);
    }
  });
});

describe("the words under the marks", () => {
  const locales = readdirSync("messages")
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.replace(".json", ""));

  it("is ten languages", () => {
    expect(locales).toHaveLength(10);
  });

  it("says all six in every one of them", () => {
    expect(countsBySaying(SHELL_KEYS).filter((row) => row.count !== 10)).toEqual([]);
  });

  it("keeps every word short enough for a 72 px cell", () => {
    // Latin letters in the bar are 10 px uppercase; the cell holds about nine
    // of them at 360. The tab clips anything longer rather than pushing its
    // neighbour, and a clipped word is still a design fault, so the limit is
    // asserted rather than trusted.
    for (const locale of locales) {
      for (const key of ["home", "explore", "make", "verify", "mine"]) {
        const word = valueAt(locale, `shell.tabs.${key}`) as string;
        expect(word.length, `${locale} ${key}: ${word}`).toBeLessThanOrEqual(10);
        expect(word).not.toContain("\n");
      }
    }
  });

  it("has taken the menu button's two keys out of all ten files", () => {
    expect(countsBySaying(GONE_KEYS).filter((row) => row.count !== 0)).toEqual([]);
  });

  it("leaves the docs toolbar its own word, which the menu never owned", () => {
    for (const locale of locales) {
      expect(valueAt(locale, "docs.menu"), locale).toBeTruthy();
    }
  });
});
