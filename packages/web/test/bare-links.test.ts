// Covers the two addresses a platform's kit or page links to without a language: /cosign and
// /connect send the browser to the default language, and /connect keeps its query.
// Does NOT cover the fragment surviving the redirect, which is the browser's job and was checked in
// a browser against the dev server; the fragment never reaches this code at all.

import { beforeEach, describe, expect, it, vi } from "vitest";

const redirect = vi.fn((to: string) => {
  throw new Error(`redirect:${to}`);
});

vi.mock("next/navigation", () => ({ redirect: (to: string) => redirect(to) }));
vi.mock("@/lib/i18n/routing", () => ({ routing: { defaultLocale: "en" } }));

const { default: BareCosignPage } = await import("../app/cosign/page");
const { default: BareConnectPage } = await import("../app/connect/page");

describe("links without a language", () => {
  beforeEach(() => {
    redirect.mockClear();
  });

  it("sends /cosign to the default language's co-sign page", () => {
    expect(() => BareCosignPage()).toThrow("redirect:/en/cosign");
  });

  it("sends /connect to the default language's connect page with its query kept", async () => {
    await expect(
      BareConnectPage({ searchParams: Promise.resolve({ origin: "https://dreamloom-production-3e74.up.railway.app" }) }),
    ).rejects.toThrow("redirect:/en/connect?origin=https%3A%2F%2Fdreamloom-production-3e74.up.railway.app");
  });

  it("sends a bare /connect with no query to the page itself", async () => {
    await expect(BareConnectPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("redirect:/en/connect");
    expect(redirect).toHaveBeenCalledWith("/en/connect");
  });
});
