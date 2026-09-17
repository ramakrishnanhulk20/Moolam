// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Fragment, act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

// The provider gives up before it fetches anything without an app id, and no
// .env is read here, so the id is set before the module is imported.
process.env.NEXT_PUBLIC_PRIVY_APP_ID = "test-app-id";

// Whether the wallet half of the app was ever fetched. The factory runs on the
// first import of the module, so a false here is proof the dynamic import never
// ran, which is the whole point of the returning gate.
const fetched = vi.hoisted(() => ({ privy: false }));

vi.mock("@/components/providers/PrivyProvider", async () => {
  const react = await import("react");
  fetched.privy = true;
  return {
    PrivyProvider: ({ children }: { children: ReactNode }) => react.createElement(react.Fragment, null, children),
  };
});

const privy = vi.hoisted(() => {
  const session = { ready: false, authenticated: false };
  return { session, usePrivy: vi.fn(() => session) };
});

vi.mock("@privy-io/react-auth", () => ({ usePrivy: privy.usePrivy }));

const { WalletProvider, RETURNING_KEY, useWalletMounted } = await import("@/components/providers/WalletProvider");
const { SessionMark } = await import("@/components/providers/SessionMark");

/** Says on the page whether the SDK's provider is above it. */
function Probe() {
  return createElement("span", null, useWalletMounted() ? "mounted" : "waiting");
}

async function mount(node: ReactNode): Promise<HTMLDivElement> {
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    createRoot(host).render(createElement(Fragment, null, node));
  });
  // The provider arrives one promise later, and its state lands in a second pass.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return host;
}

beforeEach(() => {
  window.localStorage.clear();
  privy.session.ready = false;
  privy.session.authenticated = false;
  privy.usePrivy.mockClear();
  vi.restoreAllMocks();
});

describe("who gets the wallet SDK", () => {
  // First in the file on purpose: once another case has fetched the module,
  // vitest keeps it and the record can no longer go back to false.
  it("leaves a device that has never signed in without it", async () => {
    const host = await mount(createElement(WalletProvider, { load: "returning" }, createElement(Probe)));
    expect(host.textContent).toBe("waiting");
    expect(fetched.privy).toBe(false);
    expect(privy.usePrivy).not.toHaveBeenCalled();
  });

  it("gives it to a device that has signed in here before", async () => {
    window.localStorage.setItem(RETURNING_KEY, "1");
    const host = await mount(createElement(WalletProvider, { load: "returning" }, createElement(Probe)));
    expect(host.textContent).toBe("mounted");
    expect(fetched.privy).toBe(true);
  });

  it("gives it to the signing pages whatever the device has done before", async () => {
    const host = await mount(createElement(WalletProvider, { load: "always" }, createElement(Probe)));
    expect(window.localStorage.getItem(RETURNING_KEY)).toBeNull();
    expect(host.textContent).toBe("mounted");
  });
});

describe("the mark a session leaves on the device", () => {
  it("is written once someone is signed in", async () => {
    privy.session.ready = true;
    privy.session.authenticated = true;
    await mount(createElement(SessionMark));
    expect(window.localStorage.getItem(RETURNING_KEY)).toBe("1");
  });

  it("is taken back when the SDK has looked and found nobody", async () => {
    window.localStorage.setItem(RETURNING_KEY, "1");
    privy.session.ready = true;
    privy.session.authenticated = false;
    await mount(createElement(SessionMark));
    expect(window.localStorage.getItem(RETURNING_KEY)).toBeNull();
  });

  it("is left alone while the SDK is still looking", async () => {
    window.localStorage.setItem(RETURNING_KEY, "1");
    await mount(createElement(SessionMark));
    expect(window.localStorage.getItem(RETURNING_KEY)).toBe("1");
  });

  it("paints nothing and never throws when the browser refuses storage", async () => {
    const blocked = () => {
      throw new Error("The user denied permission to access the database.");
    };
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(blocked);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(blocked);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(blocked);

    privy.session.ready = true;
    privy.session.authenticated = true;
    expect((await mount(createElement(SessionMark))).innerHTML).toBe("");

    privy.session.authenticated = false;
    expect((await mount(createElement(SessionMark))).innerHTML).toBe("");
  });
});
