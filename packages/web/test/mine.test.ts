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

  it("stands in the laptop bar's right-hand corner, pointing at the page, never prefetched", () => {
    // The corner beside the language and theme chips, which the layout draws
    // and hands the menu bar, so the account is one press away on every page.
    const at = layout.indexOf('className="tap-row ');
    expect(at).toBeGreaterThan(layout.indexOf("<MenuBar"));
    const corner = layout.slice(at, layout.indexOf("<LocaleSwitch />", at));
    expect(corner).toMatch(/<Link\s+href="\/mine"\s+prefetch=\{false\}\s+data-guide-anchor="mine"/);
    expect(corner).toContain('{menu("account")}');
  });

  it("is on the personal side of the menu as well, and never prefetched there either", () => {
    const menu = read("components/menu/menu.ts");
    expect(menu).toContain('{ key: "mine", href: "/mine", mark: "mine", prefetch: false, tab: "mine" }');
    expect(menu).not.toContain('prefetch: "intent", tab: "mine"');
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
