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

  it("is in the phone menu too, last in the list and closing it on a tap", () => {
    const menu = read("components/HeaderMenu.tsx");
    const at = menu.indexOf('href="/mine"');
    expect(at).toBeGreaterThan(-1);
    const link = menu.slice(at, at + 700);
    expect(link).toContain("prefetch={false}");
    expect(link).toContain("onClick={() => setOpenAt(null)}");
    expect(link).toContain("0{links.length + 1}");
    expect(link).toContain("{mine}");
    // The same stagger every row above it gets, and no motion for a reader who
    // asked for none.
    expect(link).toContain("animationDelay: `${40 + links.length * 45}ms`");
    expect(menu).not.toContain("MineEntry");
  });
});
