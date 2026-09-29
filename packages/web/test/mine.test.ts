import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The entry in the bar that takes anyone to their own pictures.
 *
 * It is shown to everyone, signed in or not. A first visitor should be able to
 * see that the page exists, and pressing it without an account lands on the
 * card that offers the sign in, which is the right answer rather than a dead
 * end. The one thing it must not do is prefetch: /mine carries the wallet, and
 * a reader passing through should not pull the SDK for a page they never open.
 */

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("the entry in the header", () => {
  const layout = read("app/[locale]/layout.tsx");

  it("stands in the desktop bar, last, pointing at the page", () => {
    // The layout's nav table holds the words and the fetch rule; HeaderNav
    // draws every row of it, in order, inside one nav.
    const table = layout.slice(layout.indexOf("const nav = ["), layout.indexOf("] as const;"));
    const rows = [...table.matchAll(/\{ href: "([^"]+)"/g)].map((found) => found[1]);
    expect(rows.at(-1)).toBe("/mine");
    expect(table).toContain('{ href: "/mine", label: mine("entry"), prefetch: false, anchor: "mine" }');
    expect(layout).toContain("<HeaderNav links={nav}");
    const nav = read("components/shell/HeaderNav.tsx");
    const drawn = nav.indexOf("{links.map(");
    expect(nav.indexOf("<nav")).toBeLessThan(drawn);
    expect(nav.indexOf("</nav>")).toBeGreaterThan(drawn);
    expect(nav).toContain("prefetch={link.prefetch}");
  });

  it("wears the same clothes as the six links beside it", () => {
    // One class list for every link, so My pictures cannot drift from the rest.
    const nav = read("components/shell/HeaderNav.tsx");
    expect(nav.match(/className: `tap /g)).toHaveLength(1);
    expect(nav).toContain("className: `tap whitespace-nowrap transition-colors duration-200 hover:text-accent ${");
    expect(nav).toContain('on ? "text-accent" : "text-text-muted"');
  });

  it("holds no room for anything conditional, because nothing here is", () => {
    expect(layout).not.toContain("MineEntry");
    expect(layout).not.toContain("col-start-1 row-start-1");
  });

  it("is the last tab on the phone bar, and still never prefetched", () => {
    // The menu that used to hold it is gone: below md the five tabs are the
    // navigation, and Mine is the fifth.
    const from = layout.indexOf("const tabs: Tab[] = [");
    const tabs = layout.slice(from, layout.indexOf("];", from));
    const at = layout.indexOf('key: "mine"');
    expect(at).toBeGreaterThan(layout.indexOf('key: "verify"'));
    expect(layout.slice(at, at + 160)).toContain('href: "/mine"');
    expect(layout.slice(at, at + 160)).toContain("prefetch: false");
    expect(layout.slice(at, at + 160)).toContain('anchor: "mine"');
    expect(tabs).not.toContain("MineEntry");
    expect(layout).not.toContain("HeaderMenu");
  });
});
