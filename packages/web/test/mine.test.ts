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
    const at = layout.indexOf('href="/mine"');
    expect(at).toBeGreaterThan(-1);
    // The link that follows the six the nav table holds, inside the same nav.
    expect(layout.indexOf("<nav")).toBeLessThan(at);
    expect(layout.indexOf("</nav>")).toBeGreaterThan(at);
    expect(layout.slice(at, at + 200)).toContain("prefetch={false}");
    expect(layout.slice(at, at + 400)).toContain('mine("entry")');
  });

  it("wears the same clothes as the six links beside it", () => {
    const shared = "tap text-text-muted transition-colors duration-200 hover:text-accent";
    expect(layout).toContain(`className="${shared}"`);
    expect(layout).toContain(`className="tap whitespace-nowrap text-text-muted transition-colors duration-200 hover:text-accent"`);
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
