// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Vercel's counter and Speed Insights are not in the layout's first render.
 *
 * Mounted with the layout, their code was part of the first script the home
 * page evaluates, and on 25 September that script cost 1.1 s of bootup under
 * Lighthouse's phone profile. They now wait for the browser to go idle, with a
 * timeout so a busy phone is still counted, and a plain timer where the browser
 * has no idle callback at all.
 */

vi.mock("@vercel/analytics/next", () => ({
  Analytics: () => createElement("i", { "data-part": "analytics" }),
}));
vi.mock("@vercel/speed-insights/next", () => ({
  SpeedInsights: () => createElement("i", { "data-part": "speed" }),
}));

const { IDLE_TIMEOUT_MS, LateInsights, NO_IDLE_WAIT_MS } = await import("@/components/shell/LateInsights");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const layout = readFileSync("app/[locale]/layout.tsx", "utf8");
const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function mount(): Promise<HTMLDivElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(createElement(LateInsights)));
  return host;
}

function parts(host: HTMLElement): string[] {
  return [...host.querySelectorAll("[data-part]")].map((node) => node.getAttribute("data-part") ?? "");
}

/** Lets the two import() promises settle and React commit what they bring. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("the layout", () => {
  it("no longer imports either package, so neither is in its first script", () => {
    expect(layout).not.toContain("@vercel/analytics");
    expect(layout).not.toContain("@vercel/speed-insights");
    expect(layout).not.toMatch(/<Analytics\b/);
    expect(layout).not.toMatch(/<SpeedInsights\b/);
  });

  it("mounts LateInsights in their place, still only where the visit counts", () => {
    expect(layout).toContain("{counted ? <LateInsights /> : null}");
    expect(layout).toContain('const counted = process.env.VERCEL === "1" && !labPagesOn();');
  });

  it("brings both in with import(), so their code is a chunk of its own", () => {
    const late = readFileSync("components/shell/LateInsights.tsx", "utf8");
    expect(late).toContain('import("@vercel/analytics/next")');
    expect(late).toContain('import("@vercel/speed-insights/next")');
    expect(late).not.toMatch(/^import .* from "@vercel\//m);
  });
});

describe("LateInsights", () => {
  it("renders nothing on the server, so the page's HTML carries neither", () => {
    expect(renderToStaticMarkup(createElement(LateInsights))).toBe("");
  });

  it("waits for the idle callback, with the timeout that keeps a busy phone counted", async () => {
    let fire: (() => void) | undefined;
    const asked = vi.fn((run: () => void, options?: { timeout?: number }) => {
      fire = run;
      return options?.timeout ?? 0;
    });
    vi.stubGlobal("requestIdleCallback", asked);
    vi.stubGlobal("cancelIdleCallback", vi.fn());

    const host = await mount();
    await settle();
    expect(parts(host)).toEqual([]);
    expect(asked).toHaveBeenCalledTimes(1);
    expect(asked.mock.calls[0][1]).toEqual({ timeout: IDLE_TIMEOUT_MS });

    await act(async () => fire?.());
    await settle();
    expect(parts(host)).toEqual(["analytics", "speed"]);
  });

  it("falls back to a timer where there is no idle callback", async () => {
    vi.stubGlobal("requestIdleCallback", undefined);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const host = await mount();
    await act(async () => {
      vi.advanceTimersByTime(NO_IDLE_WAIT_MS - 1);
    });
    expect(parts(host)).toEqual([]);

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    vi.useRealTimers();
    await settle();
    expect(parts(host)).toEqual(["analytics", "speed"]);
  });

  it("lets go of the wait when the page leaves first", async () => {
    const cancel = vi.fn();
    vi.stubGlobal("requestIdleCallback", vi.fn(() => 7));
    vi.stubGlobal("cancelIdleCallback", cancel);

    await mount();
    act(() => roots.splice(0).forEach((root) => root.unmount()));
    expect(cancel).toHaveBeenCalledWith(7);
  });
});
