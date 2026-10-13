import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The business page's first screen fits the screen (WO-306). Ram saw the
 * headline run six lines at 1920 by 1080, its first line under the header and
 * the buttons below the fold. The headline is now sized from the column's
 * width and the window's height, and a measuring step shrinks it further for
 * the languages that break onto more lines. These tests hold that step's
 * search and the rules the page's markup hands it. The sizes themselves were
 * measured in a real browser.
 */

const WEB = fileURLToPath(new URL("..", import.meta.url));
const read = (...parts: string[]) => readFileSync(path.join(WEB, ...parts), "utf8");

describe("the hero's markup", () => {
  const page = read("components", "business", "BusinessPage.tsx");
  const demo = read("components", "business", "DemoLoop.tsx");

  it("sizes the headline from the column's width and the window's height, times the measured shrink", () => {
    const laptop = page.match(/lg:\[--hero-type:([^\]]*)\]/)?.[1] ?? "";
    expect(laptop).toContain("cqw");
    expect(laptop).toContain("svh");
    expect(laptop).toContain("var(--hero-shrink,1)");
    // The column is a size container, which is what gives cqw its meaning.
    expect(page).toMatch(/ref=\{column\} className="@container /);
    expect(page).toContain("text-[length:var(--hero-type)]");
  });

  it("keeps a floor under the headline on every screen", () => {
    expect(page).toMatch(/\[--hero-type:max\(1\.75rem,/);
    expect(page).toMatch(/lg:\[--hero-type:max\(2\.75rem,/);
  });

  it("breaks each half of the headline evenly, so a laptop never leaves IT. alone on a line", () => {
    expect(page.match(/className="block text-balance/g)?.length).toBe(2);
  });

  it("leaves the border's one pixel out of the first screen's height", () => {
    expect(page).toContain("min-h-[calc(100svh-var(--header-h)-1px)]");
  });

  it("draws the demo's picture widescreen on a laptop and caps it by the window's height", () => {
    expect(demo).toContain("lg:aspect-[16/9]");
    expect(demo).toMatch(/lg:max-h-\[max\(10rem,calc\(100svh-var\(--header-h\)-1px-2\*var\(--hero-pad\)-[\d.]+rem\)\)\]/);
    expect(page).toContain("lg:[--hero-pad:clamp(");
  });

  it("hands the measuring step the headline's column and the language", () => {
    expect(page).toContain("useFitHeadline(column, useLocale())");
  });
});

describe("the measuring step", () => {
  const LEAD_TOP = 300;
  let resize: (() => void) | null;
  let removed: string[];
  let props: Record<string, string>;
  let host: object;
  let world: {
    wide: boolean;
    screen: number;
    header: number;
    barRoom: number;
    // The column's height at a given shrink, and how far a long word runs out of it.
    height: (shrink: number) => number;
    overflow: (shrink: number) => number;
    leadBottom: (shrink: number) => number;
  };

  const shrinkNow = () => Number.parseFloat(props["--hero-shrink"] ?? "1");

  beforeEach(() => {
    resize = null;
    removed = [];
    props = {};
    world = {
      wide: true,
      screen: 720,
      header: 63,
      barRoom: 92,
      height: (shrink) => 900 * shrink,
      overflow: () => 0,
      leadBottom: (shrink) => LEAD_TOP + 700 * shrink,
    };
    host = {
      style: {
        removeProperty: (name: string) => {
          delete props[name];
        },
        setProperty: (name: string, value: string) => {
          props[name] = value;
        },
      },
      get offsetHeight() {
        return world.height(shrinkNow());
      },
      get scrollWidth() {
        return 300 + world.overflow(shrinkNow());
      },
      clientWidth: 300,
      parentElement: {},
      querySelector: () => ({
        get offsetTop() {
          return world.leadBottom(shrinkNow()) - 50;
        },
        offsetHeight: 50,
        offsetParent: null,
      }),
      append: () => undefined,
    };
    // The step is a plain layout effect, so it is run on the spot.
    vi.doMock("react", async (original) => ({
      ...(await original<typeof import("react")>()),
      useLayoutEffect: (effect: () => void | (() => void)) => {
        (globalThis as { __cleanup?: void | (() => void) }).__cleanup = effect();
      },
    }));
    const probes: Array<{ offsetHeight: number }> = [];
    vi.stubGlobal("window", {
      matchMedia: () => ({ get matches() { return world.wide; } }),
      get innerWidth() { return world.wide ? 1280 : 375; },
      addEventListener: (_name: string, handler: () => void) => {
        resize = handler;
      },
      removeEventListener: (name: string) => removed.push(name),
    });
    vi.stubGlobal("document", {
      documentElement: {},
      createElement: () => {
        const node = {
          style: {} as Record<string, string>,
          setAttribute: () => undefined,
          append: () => undefined,
          remove: () => undefined,
          get offsetHeight() {
            // The step makes the screen-sized probe first and the bar-sized one inside it, every run.
            return probes.indexOf(node) % 2 === 0 ? world.screen : world.barRoom;
          },
        };
        probes.push(node);
        return node;
      },
      fonts: { ready: new Promise<void>(() => undefined) },
    });
    vi.stubGlobal("getComputedStyle", (node: unknown) =>
      node === (globalThis.document as { documentElement: unknown }).documentElement
        ? { getPropertyValue: () => `${world.header}px` }
        : { paddingTop: "25px", paddingBottom: "25px" },
    );
    vi.stubGlobal("requestAnimationFrame", (run: () => void) => {
      run();
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    // Each run builds fresh fakes, so the step's own memory of the last size starts empty.
    probes.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock("react");
    vi.resetModules();
  });

  async function run() {
    // Called outside a component on purpose: the mocked layout effect runs it on the spot.
    const { useFitHeadline: fitHeadline } = await import("@/components/business/useFitHeadline");
    fitHeadline({ current: host as HTMLElement }, "en");
  }

  // The column plus the grid's 50 px of padding must sit inside 720 - 63 - 1 = 656.
  const ROOM = 656 - 50;

  it("leaves the headline at its CSS size when the opening already fits", async () => {
    world.height = () => 500;
    await run();
    expect(props["--hero-shrink"]).toBeUndefined();
  });

  it("shrinks to the largest size that fits when the column is too tall", async () => {
    await run();
    const shrink = shrinkNow();
    expect(shrink).toBeLessThan(1);
    expect(world.height(shrink)).toBeLessThanOrEqual(ROOM);
    // Not smaller than it has to be: one step of the search up would no longer fit.
    expect(world.height(shrink + 0.01)).toBeGreaterThan(ROOM);
  });

  it("shrinks when a long word would run out of the column, even if the height fits", async () => {
    world.height = () => 400;
    world.overflow = (shrink) => (shrink > 0.8 ? 40 : 0);
    await run();
    const shrink = shrinkNow();
    expect(shrink).toBeLessThanOrEqual(0.8);
    expect(shrink).toBeGreaterThan(0.78);
  });

  it("holds the floor when nothing fits, instead of shrinking forever", async () => {
    world.height = () => 5000;
    await run();
    expect(shrinkNow()).toBeCloseTo(0.4, 5);
  });

  it("on a phone, clears the tab bar with the first button and ignores the column's height", async () => {
    world.wide = false;
    world.screen = 812;
    world.height = () => 5000;
    await run();
    const shrink = shrinkNow();
    expect(world.leadBottom(shrink)).toBeLessThanOrEqual(812 - 92);
    expect(world.leadBottom(shrink + 0.01)).toBeGreaterThan(812 - 92);
  });

  it("measures again when the window changes size, and lets go of the listener when the page leaves", async () => {
    await run();
    const small = shrinkNow();
    world.screen = 1080;
    resize?.();
    expect(shrinkNow()).toBeGreaterThan(small);
    // A taller window takes the headline back to the size its CSS asked for.
    world.height = () => 400;
    world.screen = 900;
    resize?.();
    expect(props["--hero-shrink"]).toBeUndefined();
    const cleanup = (globalThis as { __cleanup?: () => void }).__cleanup;
    cleanup?.();
    expect(removed).toContain("resize");
  });
});
