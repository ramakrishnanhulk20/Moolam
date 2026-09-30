// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, createElement, type FunctionComponent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import en from "@/messages/en.json";
import type { Platform, PlatformList } from "@/lib/platforms/platforms";

/**
 * P22 on the connect page: the asking site is named from Moolam's list by its
 * canonical origin, or called an unlisted site, and the person's address goes
 * to that one origin only after their press. Cancel sends nothing, and with no
 * opener there is nothing to send to.
 */

const { askerFrom } = await import("@/lib/data/platform-label");
const { ConnectPanel } = await import("@/components/connect/ConnectPanel");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WALLET = "0xc3714B31A5F300D7A79f72C7AEC61240D2f384E7" as Hex;

const ACME: Platform = {
  name: "Acme Studio",
  agentId: 4242n,
  ownerAtOnboarding: "0xa374000000000000000000000000000000009AFB" as Hex,
  creatorWallet: "0x3333333333333333333333333333333333333333",
  keyHash: `0x${"44".repeat(32)}` as Hex,
  origins: ["https://acme.example", "https://staging.acme.example"],
  validFrom: 1_780_000_000n,
  validTo: null,
  acceptedAt: 1_780_000_000n,
};
const LIST: PlatformList = { ok: true, platforms: [ACME, { ...ACME, name: "Acme Old", agentId: 7n, origins: ["https://old.example"], validTo: 1_785_000_000n, keyHash: `0x${"55".repeat(32)}` as Hex, creatorWallet: "0x4444444444444444444444444444444444444444" }] };

describe("who is asking", () => {
  it("names a listed platform by its canonical origin, in any spelling the parser accepts", () => {
    for (const spelling of ["https://acme.example", "https://ACME.example", "https://acme.example:443", "https://acme.example/"]) {
      expect(askerFrom(LIST, spelling), spelling).toEqual({ origin: "https://acme.example", name: "Acme Studio" });
    }
    expect(askerFrom(LIST, "https://staging.acme.example")).toEqual({ origin: "https://staging.acme.example", name: "Acme Studio" });
  });

  it("calls a look-alike an unlisted site and shows its exact origin", () => {
    for (const lookalike of [
      "https://acme.example.evil.example",
      "https://acrne.example",
      "https://xn--acme-9qa.example",
      "https://acme.example.",
      "https://acme.example:8443",
      "https://evil.example",
    ]) {
      const asker = askerFrom(LIST, lookalike);
      expect(asker.name, lookalike).toBeNull();
      expect(asker.origin, lookalike).not.toBeNull();
      expect(asker.origin, lookalike).not.toBe("https://acme.example");
    }
  });

  it("names nobody for a value that is not an https origin, and nobody from a retired entry or a refused list", () => {
    for (const bad of ["", "http://acme.example", "https://acme.example/connect", "https://acme.example?x=1", "https://user@acme.example", "javascript:alert(1)", "*"]) {
      expect(askerFrom(LIST, bad), bad).toEqual({ origin: null, name: null });
    }
    expect(askerFrom(LIST, "https://old.example")).toEqual({ origin: "https://old.example", name: null });
    expect(askerFrom({ ok: false, platforms: [], reason: "refused" }, "https://acme.example")).toEqual({ origin: "https://acme.example", name: null });
  });

  it("takes the origin from ?origin= on the server and keeps the page out of search", () => {
    const page = readFileSync("app/[locale]/connect/page.tsx", "utf8");
    expect(page).toContain("await askerAt(");
    expect(page).toContain("robots: { index: false, follow: false }");
  });
});

const roots: Root[] = [];
let posts: [unknown, string][] = [];

beforeEach(() => {
  posts = [];
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  Object.defineProperty(window, "opener", { value: null, configurable: true, writable: true });
});

function withOpener(): void {
  Object.defineProperty(window, "opener", {
    value: { postMessage: (message: unknown, origin: string) => posts.push([message, origin]) },
    configurable: true,
    writable: true,
  });
}

async function mount(props: Partial<Parameters<typeof ConnectPanel>[0]> = {}): Promise<HTMLDivElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{ locale: string; messages: unknown; timeZone: string; children?: unknown }>;
  const panel = createElement(ConnectPanel, {
    asker: { origin: "https://acme.example", name: "Acme Studio" },
    wallet: WALLET,
    signedIn: true,
    onSignIn: () => undefined,
    ...props,
  });
  await act(async () => root.render(createElement(Provider, { locale: "en", messages: en, timeZone: "UTC" }, panel)));
  // The panel learns whether it has an opener after the first paint, then swaps its words in.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 700));
  });
  return host;
}

/** Presses a button, then lets the state words finish swapping, so what is read after is what stays on screen. */
async function press(host: HTMLElement, selector: string): Promise<void> {
  const button = host.querySelector<HTMLButtonElement>(selector);
  expect(button, selector).not.toBeNull();
  act(() => button?.click());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 700));
  });
}

describe("P22: the address goes to one origin, only after the press", () => {
  it("shows the exact address and the asking origin, and posts nothing before the press", async () => {
    withOpener();
    const host = await mount();
    expect(host.querySelector("[data-exact-address]")?.getAttribute("data-exact-address")).toBe(WALLET);
    expect(host.querySelector("[data-asking-origin]")?.textContent).toBe("https://acme.example");
    expect(host.textContent).toContain("Acme Studio");
    expect(posts).toEqual([]);
  });

  it("posts the address once, to the asking origin only, on Share", async () => {
    withOpener();
    const host = await mount();
    await press(host, "[data-connect-share]");
    expect(posts).toEqual([[{ type: "moolam:address", address: WALLET }, "https://acme.example"]]);
    expect(host.querySelector("article")?.getAttribute("data-connect-state")).toBe("shared");
    expect(host.querySelector("[data-connect-share]")).toBeNull();
  });

  it("posts to an unlisted site's own origin only, named as unlisted", async () => {
    withOpener();
    const host = await mount({ asker: { origin: "https://acrne.example", name: null } });
    expect(host.textContent).toContain(en.connect.headingUnlisted);
    expect(host.textContent).toContain(en.connect.unlistedLine);
    await press(host, "[data-connect-share]");
    expect(posts).toEqual([[{ type: "moolam:address", address: WALLET }, "https://acrne.example"]]);
  });

  it("posts nothing on Cancel, and nothing after it", async () => {
    withOpener();
    const host = await mount();
    await press(host, "[data-connect-cancel]");
    expect(posts).toEqual([]);
    expect(host.querySelector("article")?.getAttribute("data-connect-state")).toBe("cancelled");
    expect(host.querySelector("[data-connect-share]")).toBeNull();
  });

  it("offers nothing to share without an opener, and says to open it from the site", async () => {
    const host = await mount();
    expect(host.querySelector("[data-connect-share]")).toBeNull();
    expect(host.textContent).toContain(en.connect.noOpenerLine);
  });

  it("offers nothing to share for a request that names no https site", async () => {
    withOpener();
    const host = await mount({ asker: { origin: null, name: null } });
    expect(host.querySelector("[data-connect-share]")).toBeNull();
    expect(host.textContent).toContain(en.connect.invalidLine);
    expect(posts).toEqual([]);
  });

  it("shows no address and shares nothing while signed out", async () => {
    withOpener();
    const host = await mount({ wallet: null, signedIn: false });
    expect(host.querySelector("[data-exact-address]")).toBeNull();
    expect(host.querySelector("[data-connect-sign-in]")).not.toBeNull();
    expect(host.querySelector<HTMLButtonElement>("[data-connect-share]")?.disabled).toBe(true);
    await press(host, "[data-connect-share]");
    expect(posts).toEqual([]);
  });

  it("ignores a message from the opener", async () => {
    withOpener();
    const host = await mount();
    const before = host.innerHTML.replace(/ style="[^"]*"/g, "");
    await act(async () => {
      window.dispatchEvent(new MessageEvent("message", { data: { type: "moolam:address", address: "0x0000000000000000000000000000000000000001" }, origin: "https://acme.example" }));
    });
    expect(host.innerHTML.replace(/ style="[^"]*"/g, "")).toBe(before);
    expect(posts).toEqual([]);
  });
});
