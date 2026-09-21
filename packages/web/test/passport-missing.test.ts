import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";

const stub = vi.hoisted(() => ({ record: vi.fn() }));

// next-intl's navigation helpers reach for next/navigation, which only resolves
// inside the bundler. The link is all the page's components take from it.
vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown }) => createElement("a", { href: props.href }, props.children),
  routing: { locales: ["en"], defaultLocale: "en" },
}));

/** notFound() throws in Next too, so a test can tell the three answers apart by what comes back. */
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

vi.mock("next-intl/server", () => ({
  setRequestLocale: () => undefined,
  getTranslations: async () => (key: string, values?: Record<string, string>) =>
    values === undefined ? key : `${key}: ${values.reason}`,
  getFormatter: async () => ({ dateTime: () => "" }),
}));

vi.mock("@/lib/chain/registry", async () => {
  const real = await vi.importActual<typeof import("@/lib/chain/registry")>("@/lib/chain/registry");
  return { ...real, heldPassportRecord: stub.record };
});

const { default: PassportPage } = await import("@/app/[locale]/passport/[id]/page");

const REAL_ID = `0x${"cd".repeat(32)}`;

function open(id: string) {
  return PassportPage({ params: Promise.resolve({ locale: "en", id }) });
}

beforeEach(() => {
  stub.record.mockReset();
});

describe("a passport address that is not a passport", () => {
  it("is a 404 when the id is not 32 bytes of hex, without reading the chain", async () => {
    await expect(open("0x1234")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(stub.record).not.toHaveBeenCalled();
  });

  it("is a 404 when the id is well formed and the registry has no record of it", async () => {
    stub.record.mockResolvedValue({
      passport: null,
      attestations: [],
      edits: [],
      owner: null,
      dispute: null,
      hasPasskey: false,
    });

    await expect(open(REAL_ID)).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("is not a 404 when the chain itself would not answer: that page is still there", async () => {
    stub.record.mockRejectedValue(new Error("the endpoint timed out"));

    const answer = await open(REAL_ID);

    expect(answer).not.toBeNull();
    expect(JSON.stringify(answer)).toContain("timed out");
  });
});
