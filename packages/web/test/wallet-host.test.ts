// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

// The host gives up before it fetches anything without an app id, and no .env
// is read here, so the id is set before the module is imported.
process.env.NEXT_PUBLIC_PRIVY_APP_ID = "test-app-id";

// React only accepts act() calls from a test that says it is one.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Three numbers read off the fake SDK. reads goes up each time the loader takes
// the provider out of the module, which is once per load whatever the module
// cache does, so it counts loads where a factory run would count only the first.
const counts = vi.hoisted(() => ({ reads: 0, mounts: 0, unmounts: 0 }));

vi.mock("@/components/providers/PrivyProvider", async () => {
  const react = await import("react");
  const PrivyProvider = ({ children }: { children: ReactNode }) => {
    react.useEffect(() => {
      counts.mounts += 1;
      return () => {
        counts.unmounts += 1;
      };
    }, []);
    return react.createElement(react.Fragment, null, children);
  };
  return {
    get PrivyProvider() {
      counts.reads += 1;
      return PrivyProvider;
    },
  };
});

vi.mock("@privy-io/react-auth", () => ({ usePrivy: () => ({ ready: false, authenticated: false }) }));

type WalletModule = typeof import("@/components/providers/WalletProvider");

const base: WalletModule = await import("@/components/providers/WalletProvider");

/** What each probe saw the moment it rendered, in order. */
const seen: string[] = [];

/** The host above a page, and a page standing in for a route that asks for the wallet. */
function site(wallet: WalletModule) {
  function Probe({ name }: { name: string }) {
    const mounted = wallet.useWalletMounted();
    seen.push(`${name}:${mounted ? "mounted" : "waiting"}`);
    return createElement("span", null, mounted ? "mounted" : "waiting");
  }

  function Page({ name, load }: { name: string; load?: "always" | "returning" }) {
    return createElement(wallet.WalletProvider, { load }, createElement(Probe, { name }));
  }

  function Layout({ page }: { page: ReactNode }) {
    return createElement(wallet.WalletHost, null, page);
  }

  return { Page, Layout };
}

const roots: Root[] = [];

function start(): { el: HTMLDivElement; root: Root } {
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  roots.push(root);
  return { el, root };
}

async function show(root: Root, node: ReactNode): Promise<void> {
  await act(async () => {
    root.render(node);
  });
}

/** Long enough for a dynamic import to land and its state to settle into a second pass. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
}

beforeEach(() => {
  window.localStorage.clear();
  counts.reads = 0;
  counts.mounts = 0;
  counts.unmounts = 0;
  seen.length = 0;
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) {
      root.unmount();
    }
  });
});

describe("the wallet host in the layout", () => {
  it("loads the wallet once for a page that signs, and mounts one provider", async () => {
    const { Page, Layout } = site(base);
    const { el, root } = start();

    await show(root, createElement(Layout, { page: createElement(Page, { name: "studio", load: "always" }) }));
    expect(seen[0]).toBe("studio:waiting");
    await settle();

    expect(el.textContent).toBe("mounted");
    expect(counts.reads).toBe(1);
    expect(counts.mounts).toBe(1);
  });

  it("keeps it up when one page goes and the next arrives, with no second load", async () => {
    const { Page, Layout } = site(base);
    const { el, root } = start();

    await show(root, createElement(Layout, { page: createElement(Page, { key: "studio", name: "studio" }) }));
    await settle();
    expect(el.textContent).toBe("mounted");
    expect(counts.reads).toBe(1);

    seen.length = 0;
    await show(root, createElement(Layout, { page: createElement(Page, { key: "mine", name: "mine" }) }));

    // The new page's first paint is already under the wallet: it never shows the waiting state.
    expect(seen).toEqual(["mine:mounted"]);
    expect(el.textContent).toBe("mounted");

    await settle();
    expect(counts.reads).toBe(1);
    expect(counts.mounts).toBe(1);
    expect(counts.unmounts).toBe(0);
  });

  it("gives a device that never signed in nothing for a returning page", async () => {
    const { Page, Layout } = site(base);
    const { el, root } = start();

    await show(root, createElement(Layout, { page: createElement(Page, { name: "passport", load: "returning" }) }));
    await settle();

    expect(el.textContent).toBe("waiting");
    expect(counts.reads).toBe(0);
    expect(counts.mounts).toBe(0);
  });

  it("gives a device that signed in here before the wallet, once, for a returning page", async () => {
    window.localStorage.setItem(base.RETURNING_KEY, "1");
    const { Page, Layout } = site(base);
    const { el, root } = start();

    await show(root, createElement(Layout, { page: createElement(Page, { name: "passport", load: "returning" }) }));
    await settle();

    expect(el.textContent).toBe("mounted");
    expect(counts.reads).toBe(1);
    expect(counts.mounts).toBe(1);
  });

  it("loads nothing without an app id, whatever the page or the device", async () => {
    const saved = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
    delete process.env.NEXT_PUBLIC_PRIVY_APP_ID;
    vi.resetModules();
    try {
      const bare = await import("@/components/providers/WalletProvider");
      window.localStorage.setItem(bare.RETURNING_KEY, "1");
      const { Page, Layout } = site(bare);
      const { el, root } = start();

      await show(root, createElement(Layout, { page: createElement(Page, { key: "studio", name: "studio", load: "always" }) }));
      await settle();
      await show(root, createElement(Layout, { page: createElement(Page, { key: "passport", name: "passport", load: "returning" }) }));
      await settle();

      expect(el.textContent).toBe("waiting");
      expect(counts.reads).toBe(0);
      expect(counts.mounts).toBe(0);
    } finally {
      process.env.NEXT_PUBLIC_PRIVY_APP_ID = saved;
    }
  });
});

describe("a wallet provider with no host above it", () => {
  it("still loads the wallet by itself and wraps its own children", async () => {
    const { Page } = site(base);
    const { el, root } = start();

    await show(root, createElement(Page, { name: "alone", load: "always" }));
    expect(seen[0]).toBe("alone:waiting");
    await settle();

    expect(el.textContent).toBe("mounted");
    expect(counts.reads).toBe(1);
    expect(counts.mounts).toBe(1);
  });
});
